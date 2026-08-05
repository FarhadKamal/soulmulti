import { CHARACTERS } from './characters.js';
import { send } from './net.js';
import { renderChatPanel } from './chatPanel.js';

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

  if (game.phase === 'game-over') {
    wrap.appendChild(renderGameOver(game));
    root.appendChild(wrap);
    return;
  }

  const roundInfo = document.createElement('div');
  roundInfo.className = 'round-info';
  roundInfo.textContent = `Round ${game.round}`;
  wrap.appendChild(roundInfo);

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
  const recent = log.slice(-20).reverse();
  recent.forEach((entry) => {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = describeLogEntry(entry);
    panel.appendChild(line);
  });
  return panel;
}

function describeLogEntry(entry) {
  const name = (id) => CHARACTERS[id]?.name || id;
  switch (entry.type) {
    case 'attack':
      return `${name(entry.characterId)} used ${entry.actionId} on ${name(entry.targetId)}${entry.amountDealt != null ? ` - ${entry.amountDealt} damage` : ''}${entry.koTriggered ? ' - KO!' : ''}`;
    case 'special':
      return `${name(entry.characterId)} used their SPECIAL: ${entry.actionId}${entry.targetId ? ` on ${name(entry.targetId)}` : ''}`;
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

function renderGameOver(game) {
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
  const homeBtn = document.createElement('button');
  homeBtn.textContent = 'Back to menu';
  homeBtn.onclick = () => window.location.reload();
  wrap.appendChild(homeBtn);
  return wrap;
}
