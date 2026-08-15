import { CHARACTERS } from './characters.js';
import { send } from './net.js';
import { renderChatPanel } from './chatPanel.js';
import { playUiClick } from './sound.js';
import { getFlashSrc, getPersistentPortrait } from './portraitFlash.js';
import { getActiveEffects, getClawCount } from './actionEffects.js';
import { renderFullscreenButton } from './fullscreen.js';
import { v, hardRefresh } from './assetVersion.js';

// Whether the log/chat drawer is open - module state (not part of `state`
// in main.js), same reasoning as chatPanel.js's draftText: this whole
// screen tears down and rebuilds on every server broadcast, so a plain
// local variable here is what actually survives across those rebuilds.
// Starts closed - the board/action buttons get first claim on the fixed
// viewport shell's space (see .battle/.battle-scroll in style.css); the
// drawer only takes up room once the player deliberately opens it.
let drawerOpen = false;

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
  wrap.style.position = 'relative';

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

  // The screen can flip to 'battle' (lobbyScreen.js's onEnterMatch, fired
  // off a lobby-update reporting phase 'in-match') a moment before the
  // first game-state broadcast actually arrives - e.g. joining a room mid-
  // match as a spectator, or reconnecting into one after a refresh. Rather
  // than crash on game.phase with no game yet, show a brief placeholder;
  // the very next game-state broadcast (already in flight) triggers a
  // normal rerender with the real board.
  if (!game) {
    const loading = document.createElement('div');
    loading.className = 'round-info';
    loading.textContent = 'Loading match...';
    wrap.appendChild(loading);
    root.appendChild(wrap);
    return;
  }

  if (game.phase === 'game-over') {
    stopTurnTimer();
    // Staged reveal (see main.js's startGameOverSequence): 'freeze' keeps
    // showing the live board so the winning action's own flash/shake/
    // portrait effect is actually seen instead of being cut away from the
    // instant game-over arrives (this is the actual fix for "we're missing
    // the last action" - the board below renders exactly like a normal
    // in-match frame), 'victory' swaps the winning side's OWN tiles to
    // their victory art in place (see renderFrozenBoard's isVictorious),
    // rather than showing a separate floating portrait disconnected from
    // the board, and only 'banner' (~5s later) swaps to the actual Match
    // Over screen with its Play Again / Exit controls.
    if (state.gameOverStage === 'banner') {
      wrap.appendChild(renderGameOver(game, state.room?.youAreOwner));
      root.appendChild(wrap);
      return;
    }
    wrap.appendChild(renderFrozenBoard(game, { showVictorious: state.gameOverStage === 'victory' }));
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
  const canExitGame = state.humanCount !== null && state.humanCount <= 1 && state.room?.youAreOwner;
  // A 'bots4' spectator never owns a seat (room.ownerId stays null - see
  // rooms.js's spectatorIds) so canExitGame above can never be true here,
  // and "abandon match, return to lobby" makes no sense anyway (there's no
  // lobby to return to, no seats to re-pick). Requested directly after a
  // live report: no way to leave a bot-vs-bot spectacle mid-match except
  // closing the tab. A plain full exit (leave-room, same as the game-over
  // screen's own "Exit to Main Menu" button) is the right equivalent -
  // tears the room down immediately (see leaveRoom's own spectatorIds
  // branch, index.js) since there's nothing left to watch once the one
  // viewer leaves.
  const isBotShowSpectator = state.room?.roomType === 'bots4';

  const topControls = document.createElement('div');
  topControls.className = 'top-right-controls';
  if (canExitGame) topControls.appendChild(renderExitIconButton(state));
  if (isBotShowSpectator) topControls.appendChild(renderBotShowExitButton());
  topControls.appendChild(renderHardRefreshIconButton());
  topControls.appendChild(renderFullscreenButton());
  wrap.appendChild(topControls);

  // The Yes/No confirmation is a separate row (not squeezed into the icon
  // button's own small slot) so it stays an easy, deliberate tap target -
  // same "no popups" reasoning as before, just no longer anchored to a
  // full-width button of its own when collapsed.
  if (canExitGame && state.confirmingExit) {
    wrap.appendChild(renderExitConfirmRow(state));
  }

  if (state.turnDeadline) {
    wrap.appendChild(renderTurnTimer(state.turnDeadline, actingCharacterId, mySeatCharacterIds.includes(actingCharacterId)));
  } else {
    stopTurnTimer();
  }

  const scroll = document.createElement('div');
  scroll.className = 'battle-scroll';

  const board = document.createElement('div');
  board.className = 'board';
  const ballHolderId = game.jesterBall ? game.jesterBall.holderCharacterId : null;
  // Who's cursed / genuinely still frozen right now - same helpers'
  // reasoning as the main game's characterCard.js cursedCharacterId/
  // frozenCharacterId: frozen is driven off Chronox's ongoing freezeActive
  // state, NOT the target's skipNextTurn flag, which flickers back to false
  // the instant a frozen turn is actually skipped even though the freeze is
  // still conceptually active until Chronox's own next turn resolves it.
  const athena = Object.values(game.characters).find((c) => c.id === 'athena');
  // !athena.isKO guard: server already clears curseTargetCharacterId the
  // instant Athena is KO'd (damagePipeline.js), but this check is kept
  // here too as a defensive belt-and-braces match to Chronox's own
  // freezeActive check just below, which is inherently already false once
  // he's KO'd (his freeze cleanup runs in that same server-side block).
  const cursedId = athena && !athena.isKO ? athena.special.curseTargetCharacterId : null;
  const chronox = Object.values(game.characters).find((c) => c.id === 'chronox');
  const frozenId = chronox && chronox.special.freezeActive ? chronox.special.freezeTargetId : null;
  const puppetHighlightId = state.awaitingMindControlAction ? state.mindControlPuppetId : null;
  Object.values(game.characters).forEach((character) => {
    board.appendChild(renderCharacterTile(character, {
      isActing: character.id === actingCharacterId,
      isMine: mySeatCharacterIds.includes(character.id),
      isTargetable: !!armedAction && armedAction.validTargetIds.includes(character.id),
      onTargetClick: () => onTargetPicked(character.id, state),
      isHoldingBall: character.id === ballHolderId,
      isCursed: character.id === cursedId,
      isFrozenVisual: character.id === frozenId,
      isPuppet: character.id === puppetHighlightId,
    }));
  });
  scroll.appendChild(board);

  const isMyTurn = mySeatCharacterIds.includes(actingCharacterId);
  const jb = game.jesterBall;
  const isMyBallDecision = isMyTurn && jb && jb.holderCharacterId === actingCharacterId;

  if (isMyBallDecision) {
    scroll.appendChild(renderJesterBallPrompt(game, actingCharacterId, armedAction, state));
  } else if (isMyTurn && state.awaitingMindControlAction) {
    scroll.appendChild(renderMindControlActionPanel(game, actingCharacterId, state));
  } else if (isMyTurn) {
    scroll.appendChild(renderActionPanel(actingCharacterId, usableActions, armedAction, state));
  } else {
    const waiting = document.createElement('div');
    waiting.className = 'waiting-note';
    waiting.textContent = actingCharacterId
      ? `Waiting for ${CHARACTERS[actingCharacterId].name}'s turn...`
      : 'Waiting...';
    scroll.appendChild(waiting);
  }

  wrap.appendChild(scroll);
  wrap.appendChild(renderLogChatDrawer(game.log, state.rerender));

  root.appendChild(wrap);
}

// Collapsed by default (see module-level `drawerOpen` above) so the log/
// chat never take space away from the board/action buttons unless the
// player deliberately asks for them - this is what actually fixes "always
// have to scroll to reach the action buttons", not just compacting the
// board itself.
function renderLogChatDrawer(log, rerender) {
  const wrap = document.createElement('div');
  wrap.className = 'log-chat-drawer';

  const toggle = document.createElement('button');
  toggle.className = 'drawer-toggle' + (drawerOpen ? ' drawer-toggle--open' : '');
  const label = document.createElement('span');
  label.textContent = drawerOpen ? 'Hide log & chat' : 'Show log & chat';
  const caret = document.createElement('span');
  caret.className = 'drawer-toggle-caret';
  caret.textContent = '▲'; // up-pointing triangle, flips via CSS rotate when open
  toggle.appendChild(label);
  toggle.appendChild(caret);
  toggle.onclick = () => {
    drawerOpen = !drawerOpen;
    playUiClick();
    // Local re-render only (no server round trip needed) - re-invokes
    // renderBattle with the current state, which reads the now-flipped
    // module-level drawerOpen.
    rerender();
  };
  wrap.appendChild(toggle);

  if (drawerOpen) {
    const panel = document.createElement('div');
    panel.className = 'drawer-panel';
    panel.appendChild(renderLog(log));
    panel.appendChild(renderChatPanel());
    wrap.appendChild(panel);
  }

  return wrap;
}

// Icon-only, same compact square style as the fullscreen button (see
// fullscreen.js) - sits right next to it in top-right-controls instead of
// its own separate full-width red button below the header, which read as
// an odd, disconnected banner. Clicking it arms the confirmation row
// (renderExitConfirmRow below) rather than doing anything destructive
// itself.
function renderExitIconButton(state) {
  const btn = document.createElement('button');
  btn.className = 'exit-icon-btn';
  btn.title = 'Exit Game';
  btn.textContent = '🚪';
  // Abandons the current match and returns to THIS room's character-pick
  // lobby (same room code), NOT the same as Exit Room in the pre-match
  // lobby - that removes you from the room entirely. Exit Game just
  // scraps the in-progress match so you can pick fresh characters and
  // start again, staying in the same room.
  btn.onclick = () => { playUiClick(); state.confirmingExit = true; state.rerender(); };
  return btn;
}

// A 'bots4' spectator's own exit - no confirmation needed (unlike
// renderExitIconButton's abandon-match flow above): there's no in-progress
// decision or teammates to leave hanging, just a bot-vs-bot spectacle with
// one viewer. Sends leave-room directly, same as the game-over screen's
// own "Exit to Main Menu" button - main.js's 'left-room' handler resets
// straight back to the entry screen.
function renderBotShowExitButton() {
  const btn = document.createElement('button');
  btn.className = 'exit-icon-btn';
  btn.title = 'Stop watching';
  btn.textContent = '🚪';
  btn.onclick = () => { playUiClick(); send('leave-room'); };
  return btn;
}

// Icon-only, same compact square style as fullscreen/exit - bumps the
// cache-busting version token and reloads immediately (see
// assetVersion.js's hardRefresh). One click, no confirmation: available
// mid-match too since stale-cached audio/images can surface here just as
// easily as on the entry screen, and a reload is low-stakes (you just
// reconnect as a fresh session - nothing server-side is affected).
function renderHardRefreshIconButton() {
  const btn = document.createElement('button');
  btn.className = 'hard-refresh-btn';
  btn.title = 'Hard Refresh (fixes stuck/stale images or sounds)';
  btn.textContent = '🔄';
  btn.onclick = () => hardRefresh();
  return btn;
}

// Inline confirm, not a blocking window.confirm() popup - a native dialog
// freezes the whole page (nothing else can update while it's open) and on
// mobile a mistimed tap can land on either "OK" or "Cancel" before the
// dialog has visually settled. A dedicated, always-visible "Abandon this
// match? Yes / No" row instead, impossible to mis-tap into by mistake
// since it takes a second deliberate click on the icon button above first.
function renderExitConfirmRow(state) {
  const wrap = document.createElement('div');
  wrap.className = 'exit-control';

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

// Game-over 'freeze'/'victory' stages: same board as a normal in-match
// frame, minus turn-timer/targetable/acting state (nobody's acting
// anymore) - this is what actually lets the winning action's own flash/
// shake/portrait effect (still running on its own timer in
// actionEffects.js/portraitFlash.js) be seen, instead of the screen
// cutting straight to the Match Over banner the instant game-over arrives.
function renderFrozenBoard(game, { showVictorious = false } = {}) {
  const board = document.createElement('div');
  board.className = 'board';
  const ballHolderId = game.jesterBall ? game.jesterBall.holderCharacterId : null;
  const athena = Object.values(game.characters).find((c) => c.id === 'athena');
  const cursedId = athena && !athena.isKO ? athena.special.curseTargetCharacterId : null;
  const chronox = Object.values(game.characters).find((c) => c.id === 'chronox');
  const frozenId = chronox && chronox.special.freezeActive ? chronox.special.freezeTargetId : null;
  // Only meaningful during the 'victory' stage AND once a winner actually
  // exists (a draw has no winnerPlayerId, nothing to highlight) - the
  // winning side's own surviving characters get the victory-art swap and
  // glow directly in their own tile.
  const winner = showVictorious && game.winnerPlayerId
    ? game.players.find((p) => p.id === game.winnerPlayerId)
    : null;
  Object.values(game.characters).forEach((character) => {
    board.appendChild(renderCharacterTile(character, {
      isActing: false,
      isMine: false,
      isTargetable: false,
      onTargetClick: () => {},
      isHoldingBall: character.id === ballHolderId,
      isCursed: character.id === cursedId,
      isFrozenVisual: character.id === frozenId,
      isVictorious: !!winner && winner.characterIds.includes(character.id) && !character.isKO,
    }));
  });
  return board;
}

// Extracted from renderGameOver so the 'victory' stage can show the
// winning side's art on top of the still-live board before the full
// banner (with its Play Again / Exit controls) takes over.
function renderVictoryPortraits(game) {
  const container = document.createElement('div');
  if (!game.winnerPlayerId) return container;
  const winner = game.players.find((p) => p.id === game.winnerPlayerId);
  const winningCharacterIds = (winner?.characterIds || []).filter((id) => !game.characters[id]?.isKO);
  if (winningCharacterIds.length === 0) return container;
  const portraitsRow = document.createElement('div');
  portraitsRow.className = 'victory-portraits' + (winningCharacterIds.length === 1 ? ' victory-portraits--single' : '');
  winningCharacterIds.forEach((id) => {
    const box = document.createElement('div');
    box.className = 'victory-portrait-box';
    const img = document.createElement('img');
    img.src = v(`assets/victory/${id}.jpg`);
    img.alt = CHARACTERS[id]?.name || id;
    box.appendChild(img);
    const label = document.createElement('div');
    label.className = 'victory-portrait-label';
    label.textContent = CHARACTERS[id]?.name || id;
    box.appendChild(label);
    portraitsRow.appendChild(box);
  });
  container.appendChild(portraitsRow);
  return container;
}

function renderCharacterTile(character, { isActing, isMine, isTargetable, onTargetClick, isHoldingBall, isCursed, isFrozenVisual, isVictorious, isPuppet }) {
  const def = CHARACTERS[character.id];
  const tile = document.createElement('div');
  tile.className = 'char-tile';
  if (isActing) tile.classList.add('char-tile--acting');
  // Melyssa's current Mind Control puppet - highlighted alongside her own
  // acting tile so both halves of the mechanic are visible at once.
  if (isPuppet && !character.isKO) tile.classList.add('char-tile--puppet');
  if (isMine) tile.classList.add('char-tile--mine');
  if (character.isKO) tile.classList.add('char-tile--ko');
  if (isCursed && !character.isKO) tile.classList.add('cursed-mark');
  if (isFrozenVisual && !character.isKO) tile.classList.add('ice-frozen');
  // Winning side's tile grows and glows gold during the 'victory' game-over
  // stage - swaps the victory art INTO this same tile rather than showing a
  // separate floating portrait below the board, so it reads as "this
  // character's card is celebrating" instead of a disconnected duplicate.
  if (isVictorious) tile.classList.add('char-tile--victorious');
  if (isTargetable) {
    tile.classList.add('char-tile--targetable');
    tile.onclick = onTargetClick;
  }
  tile.style.borderColor = def.color;

  // One-shot reactive tile animations (hit-flash, shake, dodge-skew,
  // divine glow, revive burst) - see actionEffects.js for trigger
  // conditions, ported 1:1 from the main game's characterCard.js.
  const effects = getActiveEffects(character.id);
  // hit-flash gets no isKO render guard here, matching the main game's
  // characterCard.js exactly (a killing blow still flashes) - every other
  // effect DOES carry the guard there, since it can otherwise still be
  // mid-animation from an earlier action when a later, unrelated hit KOs
  // the character before the timer expires.
  if (effects.has('hit')) tile.classList.add('char-tile--hit');
  if (effects.has('shake') && !character.isKO) tile.classList.add('char-tile--shake');
  if (effects.has('dodge') && !character.isKO) tile.classList.add('char-tile--dodge');
  if (effects.has('divine') && !character.isKO) tile.classList.add('char-tile--divine');
  if (effects.has('revive') && !character.isKO) tile.classList.add('char-tile--revive');
  if (effects.has('claw') && !character.isKO) {
    const claw = document.createElement('div');
    claw.className = 'claw-scratch';
    const count = Math.max(1, Math.min(getClawCount(character.id), 6));
    claw.innerHTML = Array.from({ length: count }, (_, i) =>
      `<span style="left:${(100 / (count + 1)) * (i + 1)}%; animation-delay:${i * 0.08}s"></span>`
    ).join('');
    tile.appendChild(claw);
  }
  if (effects.has('smoke') && !character.isKO) {
    const smoke = document.createElement('div');
    smoke.className = 'smoke-burst';
    smoke.innerHTML = '<span></span><span></span><span></span><span></span>';
    tile.appendChild(smoke);
  }

  if (isHoldingBall && !character.isKO) {
    // Persistent (not timed) icon on whoever currently holds the Jester
    // Ball, matching the main game's characterCard.js - purely
    // informational here since renderJesterBallPrompt's Return/Take/Pass
    // buttons already cover the interaction, unlike the main game's
    // drag-and-drop-onto-the-icon flow.
    const ball = document.createElement('div');
    ball.className = 'jesterball-holding-icon';
    ball.textContent = '💣';
    ball.title = 'Holding the Jester Ball';
    tile.appendChild(ball);
  }

  const portrait = document.createElement('img');
  portrait.className = 'char-portrait';
  // Same priority as the main game's characterCard.js: victory art (once
  // the match has actually ended and this character's side won) beats
  // everything else, including timed action-flash - there's nothing left
  // to react to once the game is over, so the celebratory art should show
  // unconditionally rather than getting preempted by e.g. a flash still
  // mid-animation from the winning hit.
  const flashSrc = getFlashSrc(character.id);
  const persistentSrc = getPersistentPortrait(character);
  if (isVictorious) {
    portrait.src = v(`assets/victory/${character.id}.jpg`);
  } else if (flashSrc) {
    // Already wrapped with v() at its source in portraitFlash.js.
    portrait.src = flashSrc;
  } else if (persistentSrc) {
    // Already wrapped with v() at its source in portraitFlash.js.
    portrait.src = persistentSrc;
  } else if (character.isKO) {
    portrait.src = v(`assets/koed/${character.id}.jpg`);
  } else if (character.hearts <= character.maxHearts / 2) {
    portrait.src = v(`assets/injured/${character.id}.jpg`);
  } else {
    portrait.src = v(`assets/portraits/${character.id}.jpg`);
  }
  portrait.alt = def.name;
  tile.appendChild(portrait);

  const name = document.createElement('div');
  name.className = 'char-name';
  name.textContent = def.name;
  tile.appendChild(name);

  const hearts = document.createElement('div');
  hearts.className = 'char-hearts';
  if (character.isKO) {
    hearts.textContent = 'KO';
  } else {
    // Filled heart glyphs for current hearts, dimmed hollow ones for the
    // rest of maxHearts - text glyphs rather than image assets, styled via
    // CSS, so no new asset files needed for this.
    for (let i = 0; i < character.maxHearts; i++) {
      const heart = document.createElement('span');
      heart.className = i < character.hearts ? 'heart-icon heart-icon--full' : 'heart-icon heart-icon--empty';
      heart.textContent = '♥';
      hearts.appendChild(heart);
    }
  }
  tile.appendChild(hearts);

  if (character.shield > 0) {
    const shield = document.createElement('div');
    shield.className = 'char-shield';
    const icon = document.createElement('span');
    icon.className = 'char-shield-icon';
    icon.textContent = '🛡';
    shield.appendChild(icon);
    const count = document.createElement('span');
    count.className = 'char-shield-count';
    count.textContent = character.shield;
    shield.appendChild(count);
    tile.appendChild(shield);
  }

  if (character.untargetable) {
    const flag = document.createElement('div');
    flag.className = 'char-flag';
    flag.textContent = 'Untargetable';
    tile.appendChild(flag);
  }

  const badges = statusBadges(character);
  if (badges.length > 0) {
    const badgeRow = document.createElement('div');
    badgeRow.className = 'status-badge-row';
    badges.forEach(({ text, cls }) => {
      const badge = document.createElement('span');
      badge.className = 'status-badge' + (cls ? ` status-badge--${cls}` : '');
      badge.textContent = text;
      badgeRow.appendChild(badge);
    });
    tile.appendChild(badgeRow);
  }

  return tile;
}

// Per-character persistent status badges - ported from the main game's
// characterCard.js statusBadges exactly (same conditions, same text).
// These are ongoing state (Zerathys's charge count in particular has no
// other visible indicator once the one-shot Charge Up flash expires),
// unlike the timed action-flash portraits/tile effects above.
function statusBadges(character) {
  const badges = [];
  if (character.usedSpecial) badges.push({ text: 'Special used', cls: 'warn' });
  switch (character.id) {
    case 'tharox':
      if (character.special.hasCharge) badges.push({ text: 'Charge ready', cls: 'warn' });
      break;
    case 'zerathys':
      badges.push({ text: `Charge: ${character.special.chargeCount}/2` });
      break;
    case 'blade':
      if (character.special.streakCount > 0) badges.push({ text: `Streak x${character.special.streakCount}`, cls: 'warn' });
      break;
    case 'kaelis':
      if (character.special.ashkaHealsRemaining > 0) {
        badges.push({ text: `Ashka heals: ${character.special.ashkaHealsRemaining}` });
      }
      break;
    case 'draxus':
      if (character.special.deathproofActive) {
        badges.push({ text: 'Deathless Fury active', cls: 'warn' });
      }
      if (character.special.bonusActionsRemaining > 0) {
        badges.push({ text: `Bonus strikes: ${character.special.bonusActionsRemaining}`, cls: 'warn' });
      }
      break;
  }
  return badges;
}

// The first ACTION_LOCKOUT_MS of your own turn, the action-pick buttons
// stay disabled (server-side, bots pace themselves the same way - see
// BOT_ACTION_DELAY_MS in index.js, kept equal to this) - purely a pacing
// choice so a turn always has a beat of "look at the board" before either
// side can act, not an anti-cheat measure. Deliberately does NOT apply to
// Cancel or target-picking once an action is armed - those already have
// their own distinct flow and this would just add friction without the
// "look before you act" purpose it serves on the very first decision of a
// turn.
const ACTION_LOCKOUT_MS = 5000;
// Mirrors server/rooms.js's TURN_TIMER_MS - the server only ever sends the
// absolute deadline (state.turnDeadline), not the total duration it was
// armed for, so this is needed here purely to work backwards to "when did
// this turn actually start" (turnDeadline - TURN_TIMER_MS) to compute the
// lockout window below. Not sent over the wire anywhere, so it has to be
// kept in sync with the server constant by hand if that one ever changes.
const TURN_TIMER_MS = 30_000;

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

  // Skipped for the Soul Swap free follow-up (awaitingSoulSwapWrath -
  // that's a forced, already-in-motion continuation of the turn, not a
  // fresh decision that needs its own "look before you act" beat).
  const lockoutUntil = (!state.awaitingSoulSwapWrath && state.turnDeadline)
    ? state.turnDeadline - TURN_TIMER_MS + ACTION_LOCKOUT_MS
    : 0;
  const lockoutActive = lockoutUntil > Date.now();

  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';
  const lockableButtons = [];
  usableActions.forEach((action) => {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    // Distinct styling for each character's one signature special ability
    // (server-flagged, see usableActionsFor in index.js) - not every
    // character has one (Blade has just his one repeatable Blood Hunt), so
    // this is a no-op for those.
    if (action.special) btn.classList.add('special-action-btn');
    btn.disabled = lockoutActive;
    lockableButtons.push(btn);
    btn.onclick = () => {
      if (btn.disabled) return;
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

  if (lockoutActive) {
    const hint = document.createElement('div');
    hint.className = 'lockout-hint';
    panel.appendChild(hint);
    // Self-ticking, same pattern as renderTurnTimer above - mutates this
    // one DOM node directly on an interval rather than triggering a full
    // renderBattle(), which would otherwise wipe out anything else
    // in-progress (chat draft, an armed action, etc.) just to update a
    // countdown. Stops itself once the lockout window passes and directly
    // un-disables the buttons in place - no server round trip needed,
    // this was always a pure client-side pacing display.
    const tick = () => {
      const msLeft = lockoutUntil - Date.now();
      if (msLeft <= 0) {
        hint.remove();
        lockableButtons.forEach((b) => { b.disabled = false; });
        clearInterval(intervalId);
        return;
      }
      hint.textContent = `Get ready... ${Math.ceil(msLeft / 1000)}s`;
    };
    const intervalId = setInterval(tick, 200);
    tick();
  }

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
  // Covers a puppeted real action's target-pick AND the puppeted
  // soulSwapWrath follow-up's target-pick alike - awaitingMindControlAction
  // stays true through the whole nested Mind Control flow (see
  // main.js/server/index.js's handleMindControlAction), so a puppeted Soul
  // Swap must route here too, never through handleSoulSwapWrath (whose
  // seat-check assumes characterId is the caster - wrong for a puppeted
  // continuation, where the client keeps sending characterId: 'melyssa').
  if (state.awaitingMindControlAction) {
    submitMindControlAction(characterId, state.mindControlPuppetId, action, targetId, state);
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

// Stage 2 of Mind Control: renders whatever the puppet's options are
// (state.usableActions, already computed server-side by
// mindControlOptionsFor - never re-derived client-side, same anti-cheat
// principle as every other action panel here). Reuses the exact same
// armed-action/target-picking pattern as renderActionPanel, just posting
// to a different message type (submitMindControlAction) instead of
// submitAction.
function renderMindControlActionPanel(game, melyssaId, state) {
  const panel = document.createElement('div');
  panel.className = 'action-panel';
  const puppet = game.characters[state.mindControlPuppetId];
  const title = document.createElement('div');
  title.className = 'action-panel-title';
  title.textContent = `Mind Control: choose ${puppet ? CHARACTERS[puppet.id].name : 'their'}'s action`;
  panel.appendChild(title);

  if (state.armedAction) {
    const prompt = document.createElement('div');
    prompt.className = 'target-prompt';
    prompt.textContent = `Choose a target for ${state.armedAction.label}...`;
    panel.appendChild(prompt);
    // A puppeted Soul Swap's free soulSwapWrath follow-up is forced, same
    // as the real (non-puppeted) case - no Cancel for it.
    if (state.armedAction.actionId !== 'soulSwapWrath') {
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => { state.armedAction = null; state.rerender(); };
      panel.appendChild(cancelBtn);
    }
    return panel;
  }

  // Same "look before you act" pacing as renderActionPanel's own lockout -
  // handleMindControlAction/handleAction's mindControl branch (server-side)
  // both call armTurnTimer fresh right before broadcasting THIS stage, so
  // turnDeadline here is a genuinely fresh 30s window for this decision,
  // not a leftover from an earlier stage - the same formula correctly
  // yields "5s from when this stage started" either way.
  const lockoutUntil = state.turnDeadline
    ? state.turnDeadline - TURN_TIMER_MS + ACTION_LOCKOUT_MS
    : 0;
  const lockoutActive = lockoutUntil > Date.now();

  const btnRow = document.createElement('div');
  btnRow.className = 'action-btn-row';
  const lockableButtons = [];
  state.usableActions.forEach((action) => {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    if (action.special) btn.classList.add('special-action-btn');
    if (action.actionId === '__mcSelfChoke') {
      btn.classList.add('self-choke-btn');
      // Detail lives in a tooltip, not the button label itself - a short
      // label keeps this row visually in line with the puppet's own real
      // option buttons instead of wrapping onto its own oversized line.
      btn.title = '1 flat damage to the puppet, ignores shield';
    }
    btn.disabled = lockoutActive;
    lockableButtons.push(btn);
    btn.onclick = () => {
      if (btn.disabled) return;
      playUiClick();
      if (!action.needsTarget) {
        submitMindControlAction(melyssaId, state.mindControlPuppetId, action, null, state);
      } else {
        state.armedAction = action;
        state.rerender();
      }
    };
    btnRow.appendChild(btn);
  });
  panel.appendChild(btnRow);

  if (lockoutActive) {
    const hint = document.createElement('div');
    hint.className = 'lockout-hint';
    panel.appendChild(hint);
    const tick = () => {
      const msLeft = lockoutUntil - Date.now();
      if (msLeft <= 0) {
        hint.remove();
        lockableButtons.forEach((b) => { b.disabled = false; });
        clearInterval(intervalId);
        return;
      }
      hint.textContent = `Get ready... ${Math.ceil(msLeft / 1000)}s`;
    };
    const intervalId = setInterval(tick, 200);
    tick();
  }

  return panel;
}

function submitMindControlAction(characterId, puppetId, action, targetId, state) {
  send('mind-control-action', { characterId, puppetId, actionId: action.actionId, targetId });
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

  const takeBtn = document.createElement('button');
  takeBtn.textContent = 'Take it (-4 hearts)';
  takeBtn.onclick = () => send('jester-ball-choice', { characterId, choice: 'take' });
  btnRow.appendChild(takeBtn);

  // Passing is now repeatable up to 5 times (jb.passCount, not the old
  // one-shot canPass flag) - there's no separate "Return to Boingo" button
  // anymore, since passing TO Boingo (now a legal target, see below) is
  // what heals him and ends the ball, same outcome as the old dedicated
  // Return choice just reached via Pass instead.
  if (jb.passCount < 5) {
    const passBtn = document.createElement('button');
    passBtn.textContent = `Pass to another player (${5 - jb.passCount} left)`;
    const holder = game.characters[characterId];
    const validTargetIds = Object.keys(game.characters).filter((id) => {
      if (id === characterId || game.characters[id].isKO) return false;
      const isBoingo = id === jb.thrownByCharacterId;
      // Boingo is a legal target regardless of team (passing to him always
      // heals him and ends the ball). Every other teammate is still
      // excluded, same as every other targeted action.
      if (game.characters[id].ownerId === holder.ownerId && !isBoingo) return false;
      return true;
    });
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

// Full, uncapped match log for the game-over screen (unlike renderLog's
// live 20-line window during play) - the whole point here is a permanent
// record of exactly what happened, in the order it happened, that the
// winner/loser can copy out and keep or share.
function renderFullLogWithCopy(log) {
  const lines = log.map((entry) => describeLogEntry(entry)).filter(Boolean);
  const wrap = document.createElement('div');
  wrap.className = 'final-log-panel';

  const header = document.createElement('div');
  header.className = 'final-log-header';
  const title = document.createElement('span');
  title.textContent = 'Match log';
  header.appendChild(title);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'final-log-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = () => {
    const text = lines.join('\n');
    // navigator.clipboard requires a secure context (https, or localhost) -
    // falls back to a hidden textarea + execCommand for plain-http LAN play
    // (e.g. a friend joining over http://<lan-ip>:8765), where
    // clipboard.writeText silently rejects.
    const done = () => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  };
  header.appendChild(copyBtn);
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'final-log-body';
  lines.forEach((text) => {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = text;
    body.appendChild(line);
  });
  wrap.appendChild(body);

  return wrap;
}

function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    onDone();
  } catch {
    // Clipboard access denied/unsupported - nothing more to do, the button
    // just silently stays "Copy" rather than throwing.
  }
  document.body.removeChild(ta);
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
  selfChoke: 'Self Choke',
  grudgeStrike: 'Grudge Strike', callAshka: 'Call Ashka',
  dyingBlow: 'Dying Blow', deathlessFury: 'Deathless Fury',
};
function actionLabel(actionId) {
  return ACTION_LABELS[actionId] || actionId;
}

function describeLogEntry(entry) {
  const name = (id) => CHARACTERS[id]?.name || id;
  switch (entry.type) {
    case 'mind-control-select':
      return `${name(entry.characterId)} took control of ${name(entry.targetId)}'s mind!`;
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
    case 'ashka-heal':
      return `${name(entry.characterId)}'s Ashka heals +${entry.healed}`;
    case 'deathless-fury-end':
      return `${name(entry.characterId)}'s Deathless Fury ends - 3 strikes granted!`;
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

  // Compact icon+label pills right under the title, not stranded at the
  // bottom below the full match log - these are the two actions someone
  // actually wants right after seeing who won, so they shouldn't require
  // scrolling past the whole log to reach.
  const btnRow = document.createElement('div');
  btnRow.className = 'game-over-actions';

  if (youAreOwner) {
    const homeBtn = document.createElement('button');
    homeBtn.className = 'game-over-pill';
    homeBtn.innerHTML = '<span>🔁</span> Play Again';
    homeBtn.title = 'Play Again (same room)';
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
  exitBtn.className = 'game-over-pill game-over-pill--exit';
  exitBtn.innerHTML = '<span>🚪</span> Exit';
  exitBtn.title = 'Exit to Main Menu';
  exitBtn.onclick = () => send('leave-room');
  btnRow.appendChild(exitBtn);

  wrap.appendChild(btnRow);

  if (game.winnerPlayerId) {
    const winner = game.players.find((p) => p.id === game.winnerPlayerId);
    const sub = document.createElement('div');
    sub.textContent = `Winner: ${winner?.name || game.winnerPlayerId}`;
    wrap.appendChild(sub);
    wrap.appendChild(renderVictoryPortraits(game));
  }
  wrap.appendChild(renderFullLogWithCopy(game.log));

  return wrap;
}
