import { CHARACTERS } from './characters.js';
import { send } from './net.js';
import { renderChatPanel } from './chatPanel.js';
import { playUiClick } from './sound.js';
import { getFlashSrc, getPersistentPortrait } from './portraitFlash.js';
import { getActiveEffects, getClawCount, getCrackCount, getPowSize, getVortexSize, getAxechopTier, getLightningTier, getWildLightningTier, getDarkslashVariant } from './actionEffects.js';
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
  // Broader than puppetHighlightId (which only covers the selection-click
  // moment): character.special.controlling is real server state that spans
  // the whole Mind Control sequence (selection through the puppeted action
  // and any nested follow-up - same window getPersistentPortrait's own
  // controlling check uses for Melyssa's own portrait). Drives the
  // hypnotic-ripple effect on the PUPPET's tile so it's visible the entire
  // time they're under control, not just the instant she picks them.
  const melyssa = Object.values(game.characters).find((c) => c.id === 'melyssa');
  const activePuppetId = melyssa && !melyssa.isKO && melyssa.special?.controlling
    ? melyssa.special.puppetCharacterId
    : null;
  // Kaelis's per-attacker grudge count (server/abilities/kaelis.js) - a
  // small badge on each ENEMY's own tile, not Kaelis's, since the count is
  // a per-relationship number ("how much grudge does she hold against ME
  // specifically") rather than something that fits on her tile without N
  // separate rows for N enemies in a 4-player match. Only shown for
  // characters with a real count > 0 against them - 0 is the no-signal
  // default, and the badge should vanish the instant Grudge Strike lands
  // and resets it, reading as "the debt was just paid."
  const kaelis = Object.values(game.characters).find((c) => c.id === 'kaelis');
  const grudgeCountFor = (characterId) => {
    if (!kaelis || kaelis.isKO || kaelis.id === characterId) return 0;
    return kaelis.special?.grudgeCounts?.[characterId] || 0;
  };
  // Rowan's Poison Cloud / Silence Lock - same "badge on the VICTIM's own
  // tile, not the caster's" reasoning as Kaelis's grudge badge above (a
  // per-relationship status, not something that fits on Rowan's own tile).
  // poisonTargets arrives as a plain array (Set -> array, sanitizeGame
  // ForBroadcast in index.js); silenceTargets arrives as a plain object
  // (Map -> Object.fromEntries, same conversion).
  const rowan = Object.values(game.characters).find((c) => c.id === 'rowan');
  const isPoisonedFor = (characterId) => {
    if (!rowan || rowan.isKO || rowan.id === characterId) return false;
    return !!rowan.special?.poisonTargets?.includes(characterId);
  };
  const silencedTurnsFor = (characterId) => {
    if (!rowan || rowan.isKO || rowan.id === characterId) return 0;
    return rowan.special?.silenceTargets?.[characterId] || 0;
  };
  // Grimtal's Skull Crack headache - same "badge on the VICTIM's own tile"
  // reasoning as poison/silence above. Strictly one-shot: true only from
  // the moment the hit lands until the victim's own next turn resolves the
  // 50% skip roll (headacheRollPending flips false either way, win or
  // lose), then this reads false again - never multi-turn, never re-armed
  // without a fresh Skull Crack.
  const grimtal = Object.values(game.characters).find((c) => c.id === 'grimtal');
  const isDazedFor = (characterId) => {
    if (!grimtal || grimtal.isKO || grimtal.id === characterId) return false;
    return grimtal.special?.headacheVictimId === characterId && !!grimtal.special?.headacheRollPending;
  };
  Object.values(game.characters).forEach((character) => {
    board.appendChild(renderCharacterTile(character, {
      isActing: character.id === actingCharacterId,
      isMine: mySeatCharacterIds.includes(character.id),
      isTargetable: !!armedAction && armedAction.validTargetIds.includes(character.id),
      onTargetClick: () => onTargetPicked(character.id, state),
      isHoldingBall: character.id === ballHolderId,
      grudgeCount: grudgeCountFor(character.id),
      isPoisoned: isPoisonedFor(character.id),
      silencedTurns: silencedTurnsFor(character.id),
      isDazed: isDazedFor(character.id),
      isCursed: character.id === cursedId,
      isFrozenVisual: character.id === frozenId,
      isPuppet: character.id === puppetHighlightId || character.id === activePuppetId,
      isHypnotized: character.id === activePuppetId,
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

function renderCharacterTile(character, { isActing, isMine, isTargetable, onTargetClick, isHoldingBall, isCursed, isFrozenVisual, isVictorious, isPuppet, isHypnotized, grudgeCount, isPoisoned, silencedTurns, isDazed }) {
  const def = CHARACTERS[character.id];
  const tile = document.createElement('div');
  tile.className = 'char-tile';
  if (isActing) tile.classList.add('char-tile--acting');
  // Melyssa's current Mind Control puppet - highlighted alongside her own
  // acting tile so both halves of the mechanic are visible at once.
  if (isPuppet && !character.isKO) tile.classList.add('char-tile--puppet');
  // Looping hypnotic-ripple pulse for the whole control window (unlike the
  // one-shot claw/crack effects), driven off real server state
  // (melyssa.special.controlling + puppetCharacterId), not just the
  // selection-click moment - so the puppet visibly reads as "under
  // control" through their own puppeted action too.
  if (isHypnotized && !character.isKO) {
    tile.classList.add('char-tile--hypnotized');
    const ripple = document.createElement('div');
    ripple.className = 'hypnotic-ripple';
    ripple.innerHTML = '<span></span><span></span><span></span>';
    tile.appendChild(ripple);
  }
  if (isMine) tile.classList.add('char-tile--mine');
  if (character.isKO) tile.classList.add('char-tile--ko');
  if (isCursed && !character.isKO) tile.classList.add('cursed-mark');
  if (isFrozenVisual && !character.isKO) tile.classList.add('ice-frozen');
  // Grimtal's Skull Crack headache: persistent (server-state-driven, not a
  // timed flash) swirl overlay for as long as the roll is pending - same
  // "real serialized state" pattern as .ice-frozen above, not a one-shot
  // portraitFlash/actionEffects animation, since this has to keep showing
  // across however many OTHER characters act before the victim's own next
  // turn finally resolves the roll.
  if (isDazed && !character.isKO) {
    tile.classList.add('char-tile--dazed');
    const dazed = document.createElement('div');
    dazed.className = 'headache-fx';
    dazed.innerHTML = '<span class="headache-star headache-star--1">✦</span>' +
      '<span class="headache-star headache-star--2">✦</span>' +
      '<span class="headache-star headache-star--3">✦</span>';
    tile.appendChild(dazed);
  }
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
  if (effects.has('crack') && !character.isKO) {
    // Scattered impact points (not a lined-up strip like claw-scratch) -
    // each cluster lands somewhere different on the tile, matching a
    // hammer hitting different spots rather than one continuous slash.
    const crack = document.createElement('div');
    crack.className = 'crack-shatter';
    const count = Math.max(1, Math.min(getCrackCount(character.id), 6));
    const positions = [
      { left: 30, top: 30 }, { left: 62, top: 22 }, { left: 45, top: 55 },
      { left: 18, top: 60 }, { left: 70, top: 58 }, { left: 50, top: 15 },
    ];
    crack.innerHTML = Array.from({ length: count }, (_, i) => {
      const pos = positions[i % positions.length];
      return `<span style="left:${pos.left}%; top:${pos.top}%; animation-delay:${i * 0.07}s"></span>`;
    }).join('');
    tile.appendChild(crack);
  }
  if (effects.has('bigshatter') && !character.isKO) {
    const shatter = document.createElement('div');
    shatter.className = 'big-shatter';
    const chipAngles = [20, 90, 160, 230, 300];
    const chips = chipAngles.map((deg) => {
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(Math.cos(rad) * 45);
      const y = Math.round(Math.sin(rad) * 45);
      return `<span class="shatter-chip" style="left:${50 + Math.cos(rad) * 12}%; top:${50 + Math.sin(rad) * 12}%; --chip-x:${x}px; --chip-y:${y}px;"></span>`;
    }).join('');
    shatter.innerHTML = `<span class="shatter-core"></span>${chips}`;
    tile.appendChild(shatter);
  }
  if (effects.has('tendrils') && !character.isKO) {
    // Curse tendrils: curling purple vine/smoke shapes that snake in from
    // the tile edges and wrap partway around, right after the eye-burst
    // flash - an organic curling motion, distinct from every other
    // effect's straight/radial/spin/pop/slam language. SVG paths for a
    // genuine curl (not achievable with plain CSS border-radius tricks).
    const tendrils = document.createElement('div');
    tendrils.className = 'curse-tendrils';
    tendrils.innerHTML = `
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path class="tendril-path tendril-path--1" d="M -5,20 Q 30,10 35,35 Q 40,60 20,55" />
        <path class="tendril-path tendril-path--2" d="M 105,30 Q 70,25 68,50 Q 66,75 85,72" />
        <path class="tendril-path tendril-path--3" d="M 50,105 Q 45,75 65,65 Q 85,55 78,35" />
      </svg>`;
    tile.appendChild(tendrils);
  }
  if (effects.has('eyeburst') && !character.isKO) {
    // Athena's Curse Strike: a big eye-flash burst the instant the curse
    // takes hold - a scaled-up version of the persistent cursed-mark's 👁
    // icon, plus a radial purple shockwave ring. Snap-in-huge-then-shrink
    // motion, distinct from every other effect's radiate/spin/pop/slam.
    const eyeburst = document.createElement('div');
    eyeburst.className = 'eye-burst';
    eyeburst.innerHTML = '<span class="eye-burst-ring"></span><span class="eye-burst-icon">👁</span>';
    tile.appendChild(eyeburst);
  }
  if (effects.has('cursesnap') && !character.isKO) {
    // Athena's curse-mirror trigger: a small eye flashes open at the
    // impact point and one thin tendril whips in and instantly recoils -
    // fast and sharp, distinct from the cast's own slow curling
    // eyeburst+tendrils ("taking hold" vs. "struck back at you").
    const snap = document.createElement('div');
    snap.className = 'curse-snap-fx';
    snap.innerHTML = `
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path class="curse-snap-whip" d="M 50,-5 Q 55,30 50,50 Q 45,70 50,105" />
      </svg>
      <span class="curse-snap-eye">👁</span>`;
    tile.appendChild(snap);
  }
  if (effects.has('choke') && !character.isKO) {
    // Melyssa's Self Choke: a constricting violet ring closes in around the
    // puppet's own portrait and snaps shut - a contracting loop, distinct
    // from every other effect's expanding/radiating/outward motion, reading
    // as an invisible grip tightening (matches her mind-control theme).
    const choke = document.createElement('div');
    choke.className = 'choke-ring';
    choke.innerHTML = '<span></span>';
    tile.appendChild(choke);
  }
  if (effects.has('ghosthand') && !character.isKO) {
    // Layered with the choke-ring: translucent purple SKELETON hand
    // silhouettes grip the portrait's left and right edges - drawn as
    // stroked bone segments + joint dots (not a filled blob, which read as
    // an unrecognizable mitten shape) so individual finger bones are
    // legible even at tile size. Makes explicit WHOSE grip is choking the
    // puppet (Melyssa's unseen control), which the ring alone doesn't
    // convey. Right hand is the left hand's paths mirrored horizontally
    // (translate+scale) rather than a hand-authored duplicate, so both
    // stay in sync if the shape is ever tuned.
    const boneHand = (mirror) => `
      <g${mirror ? ' transform="translate(40,0) scale(-1,1)"' : ''}>
        <path class="hand-bone" d="M 6,52 L 8,34" />
        <path class="hand-bone" d="M 8,34 L 6,22 L 4,14" />
        <path class="hand-bone" d="M 12,50 L 14,28" />
        <path class="hand-bone" d="M 14,28 L 13,14 L 12,4" />
        <path class="hand-bone" d="M 19,49 L 20,26" />
        <path class="hand-bone" d="M 20,26 L 20,10 L 20,0" />
        <path class="hand-bone" d="M 26,50 L 26,29" />
        <path class="hand-bone" d="M 26,29 L 27,15 L 28,6" />
        <path class="hand-bone" d="M 32,52 L 33,37" />
        <path class="hand-bone" d="M 33,37 L 35,27 L 37,20" />
        <circle class="hand-joint" cx="8" cy="34" r="1.6" />
        <circle class="hand-joint" cx="6" cy="22" r="1.4" />
        <circle class="hand-joint" cx="14" cy="28" r="1.6" />
        <circle class="hand-joint" cx="13" cy="14" r="1.4" />
        <circle class="hand-joint" cx="20" cy="26" r="1.6" />
        <circle class="hand-joint" cx="20" cy="10" r="1.4" />
        <circle class="hand-joint" cx="26" cy="29" r="1.6" />
        <circle class="hand-joint" cx="27" cy="15" r="1.4" />
        <circle class="hand-joint" cx="33" cy="37" r="1.6" />
        <circle class="hand-joint" cx="35" cy="27" r="1.4" />
        <path class="hand-palm" d="M 6,52 C 12,58 26,58 32,52 L 33,37 C 26,42 12,42 8,37 Z" />
      </g>`;
    const hands = document.createElement('div');
    hands.className = 'ghost-hands';
    hands.innerHTML = `
      <svg class="ghost-hand ghost-hand--left" viewBox="0 0 40 60">${boneHand(false)}</svg>
      <svg class="ghost-hand ghost-hand--right" viewBox="0 0 40 60">${boneHand(true)}</svg>`;
    tile.appendChild(hands);
  }
  if (effects.has('moonstreak') && !character.isKO) {
    // Moonstep, isNewTarget case: a silver afterimage streak arrives from
    // off-tile just before the crescent slash - reads as "she just
    // repositioned here," rendered first (below) so the crescent lands on
    // top of it a beat later via its own animation-delay.
    const streak = document.createElement('div');
    streak.className = 'moon-streak';
    tile.appendChild(streak);
  }
  if (effects.has('crescent') && !character.isKO) {
    // Velorya's Lunar Strike / Moonstep: a thin curved silver crescent-moon
    // slash flashing at the impact point - matches her moon/night theme,
    // distinct from every other effect (nothing else does a crescent arc).
    const crescent = document.createElement('div');
    crescent.className = 'moon-crescent';
    crescent.innerHTML = '<svg viewBox="0 0 60 60"><path d="M 44,6 A 26,26 0 1 0 44,54 A 20,20 0 1 1 44,6 Z" /></svg>';
    tile.appendChild(crescent);
  }
  if (effects.has('icecrash') && !character.isKO) {
    // Chronox's Time Freeze: crystalline ice shards crash in from multiple
    // angles and snap into place around the target the instant the freeze
    // lands - a one-shot landing moment, distinct from the persistent
    // .ice-frozen shimmer/snowflake (isFrozenVisual) that continues for the
    // rest of the freeze duration.
    const ice = document.createElement('div');
    ice.className = 'ice-crash';
    ice.innerHTML = '<span class="ice-shard ice-shard--1"></span>' +
      '<span class="ice-shard ice-shard--2"></span>' +
      '<span class="ice-shard ice-shard--3"></span>' +
      '<span class="ice-shard ice-shard--4"></span>';
    tile.appendChild(ice);
  }
  if (effects.has('poisoncloud') && !character.isKO) {
    // Rowan's Poison Cloud: a swirling green toxic mist settles over the
    // target - fires on the initial cast AND re-fires on every subsequent
    // tick (per explicit request: the effect should "reanimate" each turn
    // it deals damage, not just once). Several offset bubble/wisp shapes
    // rather than a single blob, so it reads as a living cloud rather than
    // a static overlay.
    const cloud = document.createElement('div');
    cloud.className = 'poison-cloud-fx';
    cloud.innerHTML = '<span class="poison-wisp poison-wisp--1"></span>' +
      '<span class="poison-wisp poison-wisp--2"></span>' +
      '<span class="poison-wisp poison-wisp--3"></span>' +
      '<span class="poison-wisp poison-wisp--4"></span>' +
      '<span class="poison-bubble poison-bubble--1"></span>' +
      '<span class="poison-bubble poison-bubble--2"></span>';
    tile.appendChild(cloud);
  }
  if (effects.has('mirrorshard') && !character.isKO) {
    // Rowan's Mirror Reflect counter-hit: small glass/mirror shard
    // fragments burst outward from the impact point on the ATTACKER who
    // just got hit back - reads as "your own attack shattered against a
    // mirror and came back at you," distinct from the generic hit-flash/
    // shake alone. Deliberately delayed to start AFTER the attacker's own
    // strike effect (see actionEffects.js's MIRROR_SEQUENCE_DELAY_MS).
    const shards = document.createElement('div');
    shards.className = 'mirror-shard-burst';
    const shardAngles = [15, 80, 150, 210, 280, 335];
    shards.innerHTML = shardAngles.map((deg, i) => {
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(Math.cos(rad) * 42);
      const y = Math.round(Math.sin(rad) * 42);
      return `<span class="mirror-shard" style="--shard-x:${x}px; --shard-y:${y}px; animation-delay:${i * 0.03}s; rotate:${deg}deg;"></span>`;
    }).join('');
    tile.appendChild(shards);
  }
  if (effects.has('silencelock') && !character.isKO) {
    // Rowan's Silence Lock, cast moment: two glowing chain arcs swing in
    // from opposite sides and meet at a padlock shape in the center that
    // flashes/snaps shut - matches the ability's own name/theme, distinct
    // from every other effect (nothing else does chains/binding). The
    // persistent .silence-badge (⛓️) carries the ongoing "still locked"
    // signal after this one-shot lands.
    const lock = document.createElement('div');
    lock.className = 'silence-lock-fx';
    lock.innerHTML = '<span class="lock-chain lock-chain--left"></span>' +
      '<span class="lock-chain lock-chain--right"></span>' +
      '<span class="lock-padlock">🔒</span>';
    tile.appendChild(lock);
  }
  if (effects.has('shadowstrike') && !character.isKO) {
    // Akyros's Shadow Execution: a dark blade shape stabs in from the side
    // then dissolves into wisps of black smoke - replaces the old borrowed
    // claw-scratch (which read as a Blade attack), matching her cloaked
    // shadow-assassin theme instead.
    const strike = document.createElement('div');
    strike.className = 'shadow-strike';
    strike.innerHTML = '<span class="shadow-blade"></span>' +
      '<span class="shadow-wisp shadow-wisp--1"></span>' +
      '<span class="shadow-wisp shadow-wisp--2"></span>' +
      '<span class="shadow-wisp shadow-wisp--3"></span>';
    tile.appendChild(strike);
  }
  if (effects.has('darkslash') && !character.isKO) {
    // Akyros's Fatal Slash: a quick, light straight dark slash-line
    // flickering in/out - lighter than Shadow Execution's dissolve, for a
    // routine repeatable strike. 'marked' variant (2 dmg, hit a revealed
    // hidden mark) adds a small red mark-glint at the strike point.
    const variant = getDarkslashVariant(character.id);
    const slash = document.createElement('div');
    slash.className = `dark-slash dark-slash--${variant}`;
    slash.innerHTML = '<span class="dark-slash-line"></span>' +
      (variant === 'marked' ? '<span class="mark-glint"></span>' : '');
    tile.appendChild(slash);
  }
  if (effects.has('lightning') && !character.isKO) {
    // Zerathys's Thunder Wrath (and Soul Swap Wrath, which shares the same
    // actionId): a jagged lightning bolt flashing down onto the target -
    // distinct from every other effect, nothing else does a literal bolt.
    // Scales with his charge tier: tier 1 = single thin bolt, tier 2 = two
    // bolts, tier 3 = three branching bolts converging on the strike point
    // plus a brighter core flash and the existing shake.
    const tier = getLightningTier(character.id);
    const bolt = document.createElement('div');
    bolt.className = `lightning-strike lightning-strike--tier${tier}`;
    const boltPaths = [
      'M 46,0 L 40,35 L 52,35 L 38,80',
      'M 60,0 L 66,30 L 54,32 L 64,75',
      'M 34,0 L 44,28 L 32,30 L 46,72',
    ];
    const bolts = boltPaths.slice(0, tier).map((d, i) =>
      `<path class="lightning-path" style="animation-delay:${i * 0.04}s" d="${d}" />`
    ).join('');
    bolt.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${bolts}</svg><span class="lightning-core"></span>`;
    tile.appendChild(bolt);
  }
  if (effects.has('wildlightning') && !character.isKO) {
    // Rowan's Wild Lightning: same bolt-strike structure as Zerathys's
    // Thunder Wrath above (reused deliberately), recolored via the
    // .wild-lightning-strike modifier class so the two read as related but
    // distinct spells. Tier bucketed from his random 1-7 damage roll (see
    // actionEffects.js) rather than a fixed charge tier.
    const wildTier = getWildLightningTier(character.id);
    const wildBolt = document.createElement('div');
    wildBolt.className = `lightning-strike wild-lightning-strike lightning-strike--tier${wildTier}`;
    const wildBoltPaths = [
      'M 46,0 L 40,35 L 52,35 L 38,80',
      'M 60,0 L 66,30 L 54,32 L 64,75',
      'M 34,0 L 44,28 L 32,30 L 46,72',
    ];
    const wildBolts = wildBoltPaths.slice(0, wildTier).map((d, i) =>
      `<path class="lightning-path" style="animation-delay:${i * 0.04}s" d="${d}" />`
    ).join('');
    wildBolt.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${wildBolts}</svg><span class="lightning-core"></span>`;
    tile.appendChild(wildBolt);
  }
  if (effects.has('headspin') && !character.isKO) {
    // Grimtal's Skull Crack headache, actual-skip outcome: the whole tile
    // itself visibly spins - distinct motion language from every other
    // effect here (none of which spin the CARD, only overlay shapes on top
    // of it), reading directly as "this character is too dizzy to act."
    tile.classList.add('char-tile--headspin');
  }
  if (effects.has('axechop') && !character.isKO) {
    // Draxus's Dying Blow: a downward axe-chop wedge that slams straight
    // down and embeds (directional slam, unlike every other effect's
    // radiate/spin/pop motion) - matches his axe. Tier 1-3 scales wedge
    // size/thickness; tier 3 (his 3/2/1-hearts, most desperate hits) also
    // adds a ground-crack line spreading sideways from the impact point.
    const tier = getAxechopTier(character.id);
    const chop = document.createElement('div');
    chop.className = `axe-chop axe-chop--tier${tier}`;
    chop.innerHTML = '<span class="axe-chop-wedge"></span>' +
      (tier === 3 ? '<span class="axe-chop-groundline"></span>' : '');
    tile.appendChild(chop);
  }
  if (effects.has('vortex') && !character.isKO) {
    // Chronox's Cyclone Punch: a spinning violet vortex ring reading as
    // temporal/cosmic energy rather than a physical impact mark - matches
    // his time/space theme, distinct from every other character's punch/
    // claw/crack/text language. 'big' (heads, 2 dmg) gets a second inner
    // ring counter-spinning for a more chaotic cyclone feel.
    const size = getVortexSize(character.id);
    const vortex = document.createElement('div');
    vortex.className = `vortex-burst vortex-burst--${size}`;
    vortex.innerHTML = '<span class="vortex-ring vortex-ring--outer"></span>' +
      (size === 'big' ? '<span class="vortex-ring vortex-ring--inner"></span>' : '');
    tile.appendChild(vortex);
  }
  if (effects.has('pow') && !character.isKO) {
    // Boingo's Chaos Gamble: comic-book text burst instead of the crack/
    // claw impact language everyone else uses - matches his clownish,
    // chaotic theme. 'big' (a 'win' roll) shows POW! with motion lines;
    // 'small' (a 'draw') shows a plain, smaller BAM!.
    const size = getPowSize(character.id);
    const pow = document.createElement('div');
    pow.className = `pow-burst pow-burst--${size}`;
    pow.innerHTML = `<span class="pow-text">${size === 'big' ? 'POW!' : 'BAM!'}</span>` +
      (size === 'big' ? '<span class="pow-line pow-line--1"></span><span class="pow-line pow-line--2"></span><span class="pow-line pow-line--3"></span>' : '');
    tile.appendChild(pow);
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

  if (grudgeCount > 0 && !character.isKO) {
    // Persistent per-enemy badge showing how much grudge Kaelis currently
    // holds against THIS character specifically - one number per tile
    // (never a per-enemy breakdown, which wouldn't fit), gated to only
    // render when there's a real count to show. Vanishes the instant a
    // landed Grudge Strike resets it to 0.
    const grudge = document.createElement('div');
    grudge.className = 'grudge-badge';
    grudge.textContent = `🗡${grudgeCount}`;
    grudge.title = `Kaelis's grudge: ${grudgeCount} (her next Grudge Strike on you deals ${1 + grudgeCount})`;
    tile.appendChild(grudge);
  }

  if (isPoisoned && !character.isKO) {
    // Rowan's Poison Cloud - same per-relationship-badge reasoning as
    // Kaelis's grudge badge above, positioned bottom-left so it never
    // collides with it (both could theoretically be active on the same
    // target at once). No count/duration shown since the DoT has no fixed
    // duration - it's purely a yes/no "currently poisoned" signal.
    const poison = document.createElement('div');
    poison.className = 'poison-badge';
    poison.textContent = '☠';
    poison.title = "Poisoned by Rowan's Poison Cloud - loses 1 heart at the start of every turn until cured or Rowan is KO'd";
    tile.appendChild(poison);
  }

  if (silencedTurns > 0 && !character.isKO) {
    // Rowan's Silence Lock - bottom-right, same reasoning as poison above.
    // Chain icon (matches the cast animation's own chain-arc visual, see
    // the .lock-chain elements further down) rather than a mute-speaker
    // icon, which read as "can't speak" instead of "special ability locked."
    const silence = document.createElement('div');
    silence.className = 'silence-badge';
    silence.textContent = `⛓️${silencedTurns}`;
    silence.title = `Silenced by Rowan - cannot use their special ability for ${silencedTurns} more of their own turn(s)`;
    tile.appendChild(silence);
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
  } else if (character.id === 'draxus' && character.special?.deathproofActive) {
    // Belt-and-braces: persistentSrc above already covers this, but a
    // reported-live case still showed injured.jpg during his death-proof
    // window, so guard the injured branch directly rather than relying
    // solely on priority ordering.
    portrait.src = v('assets/images/draxus/immortality.jpg');
  } else if (character.hearts <= character.maxHearts / 2) {
    portrait.src = v(`assets/injured/${character.id}.jpg`);
  } else {
    portrait.src = v(`assets/portraits/${character.id}.jpg`);
  }
  portrait.alt = def.name;
  // Soul Swap: a quick color-invert flash directly on the victim's own
  // portrait (photo-negative look, snapping back to normal) - reads as
  // "something was yanked out of you," matching that Soul Swap trades
  // heart values rather than dealing damage. Applied as a class on the
  // real portrait element itself, no cloned ghost image needed.
  if (effects.has('invertflash') && !character.isKO) {
    portrait.classList.add('portrait-invert-flash');
  }
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
    badges.forEach(({ text, cls, title }) => {
      const badge = document.createElement('span');
      badge.className = 'status-badge' + (cls ? ` status-badge--${cls}` : '');
      badge.textContent = text;
      // Icon-only badges (e.g. Marin's passives) carry their full name here
      // instead of in the visible text, so a hover still reveals what the
      // icon means without cluttering the tile - optional, most badges
      // elsewhere already say enough in their own text and skip this.
      if (title) badge.title = title;
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
  // Boingo gets his own dedicated "Jester Ball: N/2" badge below instead of
  // the generic one - he has 2 throws per match (see state.js's
  // jesterBallsUsed), and usedSpecial only flips true once BOTH are spent,
  // so the generic badge alone would only ever announce "fully out," never
  // show he still has a throw in reserve after using just one.
  if (character.usedSpecial && character.id !== 'boingo') badges.push({ text: 'Special used', cls: 'warn' });
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
    case 'rowan':
      if (character.special.arcaneStudyPending) {
        badges.push({ text: 'Studying...' });
      }
      badges.push({ text: `Spells: ${character.special.discoveredSpells.length}/5` });
      if (character.special.mirrorReflectActive) {
        badges.push({ text: 'Mirror active', cls: 'warn' });
      }
      break;
    case 'marin':
      if (character.special.arcaneStudyPending) {
        badges.push({ text: 'Studying...' });
      }
      badges.push({ text: `Spells: ${character.special.discoveredSpells.length}/5` });
      if (character.special.everbloomActive) {
        // Permanent passive with no cast moment - same "give it an ongoing
        // badge, not just a per-tick flash" reasoning as Clean Slate below.
        // Icon-only (no label text) - keeps the tile from getting cluttered
        // once several of these badges stack up at once; each icon's
        // meaning is established by its own discovery flash/voice line.
        badges.push({ text: '🍃', title: 'Everbloom active - heals +1 every other of her own turns' });
      }
      if (character.special.veilChargesRemaining > 0) {
        badges.push({ text: `🌀 ${character.special.veilChargesRemaining}`, title: 'Threefold Veil - dodge charges remaining' });
      }
      if (character.special.piercingWandActive) {
        // Permanent passive, one-shot discovery flash only - same "no
        // ongoing confirmation otherwise" reasoning as Everbloom above.
        badges.push({ text: '🗡️', title: 'Piercing Wand - Wand Strike ignores shield' });
      }
      if (character.special.wandMasteryActive) {
        badges.push({ text: '⭐', title: 'Wand Mastery - Wand Strike deals 2 damage' });
      }
      if (character.special.cleanSlateArmed) {
        // Discovered but hasn't fired yet - a purely reactive, one-time
        // trigger (see tryTriggerCleanSlate in damagePipeline.js) with no
        // cast moment of its own, so this is the ONLY persistent signal
        // it's loaded at all before it actually goes off. Confirmed report:
        // without this, the only confirmation was a flash at the exact
        // instant it triggers (easy to miss) plus a log line - no ongoing
        // "this is active and waiting" indicator like every other spell.
        badges.push({ text: '🕯️', title: 'Clean Slate ready - will cleanse and grant immunity on the next negative status' });
      }
      if (character.special.cleanSlateImmuneTurnsRemaining > 0) {
        badges.push({ text: `🕯️ ${character.special.cleanSlateImmuneTurnsRemaining}`, cls: 'warn', title: 'Clean Slate immunity - turns remaining' });
      }
      break;
    case 'boingo':
      badges.push({ text: `Jester Ball: ${character.special.jesterBallsUsed}/2` });
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
  wandStrike: 'Wand Strike', arcaneStudy: 'Arcane Study',
  poisonCloud: 'Poison Cloud', purify: 'Purify', wildLightning: 'Wild Lightning',
  mirrorReflect: 'Mirror Reflect', silenceLock: 'Silence Lock',
  everbloom: 'Everbloom', threefoldVeil: 'Threefold Veil', cleanSlate: 'Clean Slate',
  piercingWand: 'Piercing Wand', wandMastery: 'Wand Mastery',
  grimStrike: 'Grim Strike', skullCrack: 'Skull Crack',
};

// Rowan's and Marin's discoverable spells, shared by describeLogEntry's
// 'spell-discovered' case to show a real name instead of the raw id - the
// two characters' spell ids never collide, so one flat lookup covers both.
const SPELL_NAMES = {
  poisonCloud: 'Poison Cloud', purify: 'Purify', wildLightning: 'Wild Lightning',
  mirrorReflect: 'Mirror Reflect', silenceLock: 'Silence Lock',
  everbloom: 'Everbloom', threefoldVeil: 'Threefold Veil', cleanSlate: 'Clean Slate',
  piercingWand: 'Piercing Wand', wandMastery: 'Wand Mastery',
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
      return `${name(entry.characterId)} used their SPECIAL: ${actionLabel(entry.actionId)}${entry.targetId ? ` on ${name(entry.targetId)}` : ''}${entry.blocked ? ' - blocked by Clean Slate!' : ''}`;
    case 'setup':
      return `${name(entry.characterId)} used ${actionLabel(entry.actionId)}${entry.chargeCount ? ` (${entry.chargeCount}/2)` : ''}`;
    case 'hidden-mark':
      return `${name(entry.characterId)} placed a Hidden Mark`;
    case 'curse':
      return `${name(entry.characterId)} cast Curse Strike on ${name(entry.targetId)}${entry.blocked ? ' - blocked by Clean Slate!' : ''}`;
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
    case 'spell-discovered':
      return entry.spellId
        ? `${name(entry.characterId)} discovered a new spell: ${SPELL_NAMES[entry.spellId] || entry.spellId}!`
        : `${name(entry.characterId)}'s Arcane Study found nothing new.`;
    case 'poison-tick':
      return `${name(entry.targetCharacterId)} takes ${entry.amountDealt} poison damage${entry.koTriggered ? ' - KO!' : ''}`;
    case 'silence-end':
      return `${name(entry.targetCharacterId)}'s Silence Lock wears off`;
    case 'mirror-reflect':
      return `${name(entry.fromCharacterId)}'s Mirror Reflect deals ${entry.amount} damage back to ${name(entry.toCharacterId)}${entry.koTriggered ? ' - KO!' : ''}`;
    case 'everbloom-tick':
      return `${name(entry.characterId)}'s Everbloom heals +${entry.healed}`;
    case 'clean-slate-trigger':
      return `${name(entry.characterId)}'s Clean Slate activates - cleansed and protected!`;
    case 'clean-slate-immunity-end':
      return `${name(entry.characterId)}'s Clean Slate protection fades`;
    case 'grim-ward-reward': {
      const parts = [];
      if (entry.healed) parts.push(`+${entry.healed} heart${entry.healed > 1 ? 's' : ''}`);
      if (entry.shielded) parts.push(`+${entry.shielded} shield`);
      return `${name(entry.targetCharacterId)}'s Grim Ward triggers${parts.length ? ` - ${parts.join(', ')}` : ''}`;
    }
    case 'headache-roll':
      return entry.skipped
        ? `${name(entry.targetCharacterId)}'s headache flares up - turn skipped!`
        : `${name(entry.targetCharacterId)} shakes off the headache`;
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
