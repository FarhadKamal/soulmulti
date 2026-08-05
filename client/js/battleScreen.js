import { CHARACTERS } from './characters.js';
import { send } from './net.js';
import { renderChatPanel } from './chatPanel.js';
import { playUiClick } from './sound.js';
import { getFlashSrc, getPersistentPortrait } from './portraitFlash.js';

// Functional-first battle screen: no portrait art/animation yet (see
// characterCard.js in the main game for that system) - just hearts,
// shield, status, and clickable action/target buttons driven entirely by
// the server's `usableActions` summary so the client never has to
// reimplement ability legality rules itself.
export function renderBattle(root, state) {
  const { game, actingCharacterId, usableActions, awaitingSoulSwapWrath, mySeatCharacterIds, armedAction } = state;
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'battle';

  if (state.connectionLost) {
    stopTurnTimer();
    const err = document.createElement('div');
    err.className = 'error-banner';
    const text = document.createElement('span');
    text.textContent = 'Connection lost.';
    err.appendChild(text);
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'refresh-btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = () => window.location.reload();
    err.appendChild(refreshBtn);
    wrap.appendChild(err);
    root.appendChild(wrap);
    return;
  }

  if (game.phase === 'game-over') {
    stopTurnTimer();
    wrap.appendChild(renderGameOver(game, state.room?.youAreOwner));
    root.appendChild(wrap);
    return;
  }

  const roundInfo = document.createElement('div');
  roundInfo.className = 'round-info';
  roundInfo.textContent = `Round ${game.round}`;
  wrap.appendChild(roundInfo);

  // Only offered when playing solo against bots (humanCount <= 1) AND to
  // the room owner - with real opponents/teammates still in the match,
  // leaving mid-game abandons them, which isn't something to one-click out
  // of. Solo-vs-bots is the "I want out of this, nobody's affected" case
  // this button is for (in that case the lone human is necessarily the
  // owner, but checking youAreOwner directly is more explicit/robust than
  // relying on that inference).
  if (state.humanCount !== null && state.humanCount <= 1 && state.room?.youAreOwner) {
    wrap.appendChild(renderExitGameControl(state));
  }

  if (state.turnDeadline) {
    wrap.appendChild(renderTurnTimer(state.turnDeadline, actingCharacterId, mySeatCharacterIds.includes(actingCharacterId)));
  } else {
    stopTurnTimer();
  }

  const board = document.createElement('div');
  board.className = 'board';
  Object.values(game.characters).forEach((character) => {
    board.appendChild(renderCharacterTile(character, {
      isActing: character.id === actingCharacterId,
      isMine: mySeatCharacterIds.includes(character.id),
      isTargetable: !!armedAction && armedAction.validTargetIds.includes(character.id),
      onTargetClick: () => onTargetPicked(character.id, state),
    }));
  });
  wrap.appendChild(board);

  const isMyTurn = mySeatCharacterIds.includes(actingCharacterId);
  const jb = game.jesterBall;
  const isMyBallDecision = isMyTurn && jb && jb.holderCharacterId === actingCharacterId;

  if (isMyBallDecision) {
    wrap.appendChild(renderJesterBallPrompt(game, actingCharacterId, armedAction, state));
  } else if (isMyTurn) {
    wrap.appendChild(renderActionPanel(actingCharacterId, usableActions, armedAction, state));
  } else {
    const waiting = document.createElement('div');
    waiting.className = 'waiting-note';
    waiting.textContent = actingCharacterId
      ? `Waiting for ${CHARACTERS[actingCharacterId].name}'s turn...`
      : 'Waiting...';
    wrap.appendChild(waiting);
  }

  wrap.appendChild(renderLog(game.log));
  wrap.appendChild(renderChatPanel());

  root.appendChild(wrap);
}

// Inline confirm, not a blocking window.confirm() popup - a native dialog
// freezes the whole page (nothing else can update while it's open) and on
// mobile a mistimed tap can land on either "OK" or "Cancel" before the
// dialog has visually settled. Clicking "Exit Game" swaps the button for a
// same-panel "Abandon this match? Yes / No" row instead, which is always
// visible and impossible to mis-tap into by mistake since it takes a
// second deliberate click.
function renderExitGameControl(state) {
  const wrap = document.createElement('div');
  wrap.className = 'exit-control';

  if (state.confirmingExit) {
    const prompt = document.createElement('span');
    prompt.className = 'exit-confirm-prompt';
    prompt.textContent = 'Abandon this match?';
    wrap.appendChild(prompt);

    const yesBtn = document.createElement('button');
    yesBtn.className = 'exit-confirm-yes';
    yesBtn.textContent = 'Yes, exit';
    yesBtn.onclick = () => send('abandon-match');
    wrap.appendChild(yesBtn);

    const noBtn = document.createElement('button');
    noBtn.className = 'exit-confirm-no';
    noBtn.textContent = 'No';
    noBtn.onclick = () => { state.confirmingExit = false; state.rerender(); };
    wrap.appendChild(noBtn);
  } else {
    const exitBtn = document.createElement('button');
    exitBtn.className = 'exit-btn';
    exitBtn.textContent = 'Exit Game';
    // Abandons the current match and returns to THIS room's character-pick
    // lobby (same room code), NOT the same as Exit Room in the pre-match
    // lobby - that removes you from the room entirely. Exit Game just
    // scraps the in-progress match so you can pick fresh characters and
    // start again, staying in the same room.
    exitBtn.onclick = () => { state.confirmingExit = true; state.rerender(); };
    wrap.appendChild(exitBtn);
  }

  return wrap;
}

// Ticks a countdown to the server's turn-decision deadline (see
// armTurnTimer/broadcastGameState in index.js - the server is the sole
// authority on when a turn actually times out; this is purely a display of
// that same deadline, not an independent timer). Self-updates via its own
// setInterval rather than triggering a full renderBattle() every second,
// since a full re-render would blow away in-progress interactions (like an
// armed action waiting on a target click). Only one interval is ever live
// at a time - each call clears whatever the previous rendered timer had
// running, so repeated renderBattle() calls (e.g. a chat message arriving)
// don't stack multiple ticking intervals against the same deadline.
let turnTimerInterval = null;
function stopTurnTimer() {
  if (turnTimerInterval) {
    clearInterval(turnTimerInterval);
    turnTimerInterval = null;
  }
}
function renderTurnTimer(deadline, actingCharacterId, isMyTurn) {
  stopTurnTimer();

  const badge = document.createElement('div');
  badge.className = 'turn-timer';

  function update() {
    const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    badge.textContent = isMyTurn
      ? `Your turn - ${secondsLeft}s left`
      : `${CHARACTERS[actingCharacterId]?.name || 'Player'}'s turn - ${secondsLeft}s left`;
    badge.classList.toggle('turn-timer--urgent', secondsLeft <= 10);
    if (secondsLeft <= 0) clearInterval(turnTimerInterval);
  }
  update();
  turnTimerInterval = setInterval(update, 1000);

  return badge;
}

function renderCharacterTile(character, { isActing, isMine, isTargetable, onTargetClick }) {
  const def = CHARACTERS[character.id];
  const tile = document.createElement('div');
  tile.className = 'char-tile';
  if (isActing) tile.classList.add('char-tile--acting');
  if (isMine) tile.classList.add('char-tile--mine');
  if (character.isKO) tile.classList.add('char-tile--ko');
  if (isTargetable) {
    tile.classList.add('char-tile--targetable');
    tile.onclick = onTargetClick;
  }
  tile.style.borderColor = def.color;

  const portrait = document.createElement('img');
  portrait.className = 'char-portrait';
  // Same priority as the main game's characterCard.js: timed action-flash
  // (Athena's kiss, Zerathys's glass, dodge, etc.) beats persistent state
  // (Velorya hidden/Blade alive) beats KO beats injured beats default.
  // Victory art doesn't apply here - game-over routes to renderGameOver()
  // above, the board is never shown once the match has actually ended.
  const flashSrc = getFlashSrc(character.id);
  const persistentSrc = getPersistentPortrait(character);
  if (flashSrc) {
    portrait.src = flashSrc;
  } else if (persistentSrc) {
    portrait.src = persistentSrc;
  } else if (character.isKO) {
    portrait.src = `assets/koed/${character.id}.jpg`;
  } else if (character.hearts <= character.maxHearts / 2) {
    portrait.src = `assets/images/injured/${character.id}.jpg`;
  } else {
    portrait.src = `assets/portraits/${character.id}.jpg`;
  }
  portrait.alt = def.name;
  tile.appendChild(portrait);

  const name = document.createElement('div');
  name.className = 'char-name';
  name.textContent = def.name;
  tile.appendChild(name);

  const hearts = document.createElement('div');
  hearts.className = 'char-hearts';
  hearts.textContent = character.isKO ? 'KO' : `${character.hearts}/${character.maxHearts} hearts`;
  tile.appendChild(hearts);

  if (character.shield > 0) {
    const shield = document.createElement('div');
    shield.className = 'char-shield';
    shield.textContent = `Shield: ${character.shield}`;
    tile.appendChild(shield);
  }

  if (character.untargetable) {
    const flag = document.createElement('div');
    flag.className = 'char-flag';
    flag.textContent = 'Untargetable';
    tile.appendChild(flag);
  }

  if (character.skipNextTurn) {
    const flag = document.createElement('div');
    flag.className = 'char-flag';
    flag.textContent = 'Frozen';
    tile.appendChild(flag);
  }

  return tile;
}

function renderActionPanel(characterId, usableActions, armedAction, state) {
  const panel = document.createElement('div');
  panel.className = 'action-panel';

  if (armedAction) {
    const prompt = document.createElement('div');
    prompt.className = 'target-prompt';
    prompt.textContent = `Choose a target for ${armedAction.label}...`;
    panel.appendChild(prompt);
    // The Soul Swap follow-up (soulSwapWrath) is a forced free hit, not an
    // optional choice - there's no legal way to skip it, so no Cancel here.
    if (armedAction.actionId !== 'soulSwapWrath') {
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => { state.armedAction = null; state.rerender(); };
      panel.appendChild(cancelBtn);
    }
    return panel;
  }

  const title = document.createElement('div');
  title.className = 'action-panel-title';
  title.textContent = state.awaitingSoulSwapWrath ? 'Soul Swap landed - choose your free Thunder Wrath target' : 'Your turn - choose an action';
  panel.appendChild(title);

  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';
  usableActions.forEach((action) => {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.onclick = () => {
      playUiClick();
      if (!action.needsTarget) {
        submitAction(characterId, action, null, state);
      } else {
        state.armedAction = action;
        state.rerender();
      }
    };
    btnRow.appendChild(btn);
  });
  panel.appendChild(btnRow);
  return panel;
}

function onTargetPicked(targetId, state) {
  if (!state.armedAction) return;
  const action = state.armedAction;
  const characterId = state.actingCharacterId;
  state.armedAction = null;
  if (action.actionId === '__jesterBallPass') {
    send('jester-ball-choice', { characterId, choice: 'pass', targetId });
    return;
  }
  submitAction(characterId, action, targetId, state);
}

function submitAction(characterId, action, targetId, state) {
  if (state.awaitingSoulSwapWrath) {
    send('soul-swap-wrath', { characterId, targetId });
  } else {
    send('action', { characterId, actionId: action.actionId, targetId });
  }
}

function renderJesterBallPrompt(game, characterId, armedAction, state) {
  const jb = game.jesterBall;
  const panel = document.createElement('div');
  panel.className = 'action-panel jester-ball-panel';
  const title = document.createElement('div');
  title.className = 'action-panel-title';
  title.textContent = "You're holding the Jester Ball!";
  panel.appendChild(title);

  if (armedAction && armedAction.actionId === '__jesterBallPass') {
    const prompt = document.createElement('div');
    prompt.className = 'target-prompt';
    prompt.textContent = 'Choose who to pass the ball to...';
    panel.appendChild(prompt);
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => { state.armedAction = null; state.rerender(); };
    panel.appendChild(cancelBtn);
    return panel;
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';

  const returnBtn = document.createElement('button');
  returnBtn.textContent = 'Return to Boingo';
  returnBtn.onclick = () => send('jester-ball-choice', { characterId, choice: 'return_' });
  btnRow.appendChild(returnBtn);

  const takeBtn = document.createElement('button');
  takeBtn.textContent = 'Take it (-4 hearts)';
  takeBtn.onclick = () => send('jester-ball-choice', { characterId, choice: 'take' });
  btnRow.appendChild(takeBtn);

  if (jb.canPass) {
    const passBtn = document.createElement('button');
    passBtn.textContent = 'Pass to another player';
    const validTargetIds = Object.keys(game.characters).filter((id) => id !== characterId && !game.characters[id].isKO);
    passBtn.onclick = () => {
      state.armedAction = { actionId: '__jesterBallPass', label: 'Pass the Jester Ball', needsTarget: true, validTargetIds };
      state.rerender();
    };
    btnRow.appendChild(passBtn);
  }

  panel.appendChild(btnRow);
  return panel;
}

function renderLog(log) {
  const panel = document.createElement('div');
  panel.className = 'log-panel';
  // end-action is a pure bookkeeping marker (round/hearts snapshot pushed
  // after every single action, always) rather than a human-readable event -
  // describeLogEntry correctly has no text for it, but rendering an empty
  // .log-line per entry anyway left visible blank gaps in the panel. Filter
  // to only entries with real text, then take the most recent 20 of those.
  const described = log.map((entry) => ({ entry, text: describeLogEntry(entry) })).filter((e) => e.text);
  const recent = described.slice(-20).reverse();
  recent.forEach(({ text }) => {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = text;
    panel.appendChild(line);
  });
  return panel;
}

// Mirrors each ability's `label` field server-side (abilities/*.js) - kept
// as a client-side lookup rather than plumbed through every log entry,
// since action ids are stable, non-secret game data.
const ACTION_LABELS = {
  cyclonePunch: 'Cyclone Punch', timeFreeze: 'Time Freeze',
  smash: 'Smash', titanToss: 'Titan Toss', titanSmash: 'Titan Smash', glorySmash: 'Glory Smash',
  chargeUp: 'Charge Up', thunderWrath: 'Thunder Wrath', soulSwap: 'Soul Swap', soulSwapWrath: 'Thunder Wrath (free)',
  hiddenMark: 'Hidden Mark', fatalSlash: 'Fatal Slash', shadowExecution: 'Shadow Execution',
  lunarStrike: 'Lunar Strike', moonstep: 'Moonstep', lunarEclipse: 'Lunar Eclipse',
  chaosGamble: 'Chaos Gamble', jesterBall: 'Jester Ball', bloodHunt: 'Blood Hunt',
  curseStrike: 'Curse Strike', divineRestore: 'Divine Restore',
};
function actionLabel(actionId) {
  return ACTION_LABELS[actionId] || actionId;
}

function describeLogEntry(entry) {
  const name = (id) => CHARACTERS[id]?.name || id;
  switch (entry.type) {
    case 'attack':
      return `${name(entry.characterId)} used ${actionLabel(entry.actionId)} on ${name(entry.targetId)}${entry.amountDealt != null ? ` - ${entry.amountDealt} damage` : ''}${entry.koTriggered ? ' - KO!' : ''}`;
    case 'special':
      return `${name(entry.characterId)} used their SPECIAL: ${actionLabel(entry.actionId)}${entry.targetId ? ` on ${name(entry.targetId)}` : ''}`;
    case 'setup':
      return `${name(entry.characterId)} used ${actionLabel(entry.actionId)}${entry.chargeCount ? ` (${entry.chargeCount}/2)` : ''}`;
    case 'hidden-mark':
      return `${name(entry.characterId)} placed a Hidden Mark`;
    case 'curse':
      return `${name(entry.characterId)} cast Curse Strike on ${name(entry.targetId)}`;
    case 'curse-mirror':
      return `Curse mirrors ${entry.amount} damage to ${name(entry.toCharacterId)}${entry.koTriggered ? ' - KO!' : ''}`;
    case 'rebirth':
      return `${name(entry.targetCharacterId)} used REBIRTH - revived with 2 hearts!`;
    case 'dodge':
      return `${name(entry.targetCharacterId)} dodged ${name(entry.attackerId)}'s attack!`;
    case 'freeze-continue':
      return `Time Freeze continues on ${name(entry.targetCharacterId)}`;
    case 'freeze-end':
      return `Time Freeze ends on ${name(entry.targetCharacterId)}`;
    case 'eclipse-end':
      return `${name(entry.characterId)}'s Lunar Eclipse ends`;
    case 'jester-ball-take':
      return `${name(entry.targetCharacterId)} took the Jester Ball${entry.amountDealt != null ? ` - -${entry.amountDealt} hearts` : ''}`;
    case 'jester-ball-pass':
      return `${name(entry.fromCharacterId)} passed the Jester Ball to ${name(entry.toCharacterId)}`;
    case 'jester-ball-return':
      return `Jester Ball returned to ${name(entry.boingoId)}${entry.healed ? ` - healed ${entry.healed}` : ''}`;
    case 'passive':
      return entry.text;
    default:
      return null;
  }
}

function renderGameOver(game, youAreOwner) {
  const wrap = document.createElement('div');
  wrap.className = 'game-over';
  const title = document.createElement('h2');
  title.textContent = game.winnerPlayerId ? 'Match over!' : 'Draw!';
  wrap.appendChild(title);
  if (game.winnerPlayerId) {
    const winner = game.players.find((p) => p.id === game.winnerPlayerId);
    const sub = document.createElement('div');
    sub.textContent = `Winner: ${winner?.name || game.winnerPlayerId}`;
    wrap.appendChild(sub);
  }
  const btnRow = document.createElement('div');
  btnRow.className = 'game-over-actions';

  if (youAreOwner) {
    const homeBtn = document.createElement('button');
    homeBtn.textContent = 'Play Again (same room)';
    // Returns everyone in this room to the SAME room's lobby (same code) so
    // the group can pick again and play another match without re-sharing a
    // code - a plain page reload would instead drop the WebSocket entirely
    // and start a brand new, unrelated session.
    homeBtn.onclick = () => send('return-to-lobby');
    btnRow.appendChild(homeBtn);
  } else {
    const waiting = document.createElement('div');
    waiting.className = 'waiting-note';
    waiting.textContent = 'Waiting for the room owner to return to the lobby...';
    btnRow.appendChild(waiting);
  }

  // Available to anyone regardless of ownership - a full exit back to the
  // create/join entry screen, distinct from "Play Again" above (which only
  // the owner can trigger and keeps everyone in the same room/code).
  const exitBtn = document.createElement('button');
  exitBtn.className = 'exit-btn';
  exitBtn.textContent = 'Exit to Main Menu';
  exitBtn.onclick = () => send('leave-room');
  btnRow.appendChild(exitBtn);

  wrap.appendChild(btnRow);
  return wrap;
}
