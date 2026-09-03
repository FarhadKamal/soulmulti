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

  // A match can NEVER be force-abandoned/reset for everyone mid-battle
  // (confirmed ruling: "game cannot be exit during battle. only leave
  // button possible... we already have logic if all human left, room will
  // get destroy auto") - there is no owner-only "Exit Game"/abandon-match
  // capability at all anymore. Every participant - seated player, Guest,
  // or a bots4 spectator - gets the exact same simple Leave button, which
  // only ever removes THEM (their seat converts to a bot immediately, same
  // as any disconnect - see server's leaveRoom/permanentlyConvertSeatToBot).
  // The room's own lifecycle already tears itself down automatically once
  // truly nobody real is left (anyoneStillInRoom, index.js) - no separate
  // manual reset button is needed for that case either.
  const topControls = document.createElement('div');
  topControls.className = 'top-right-controls';
  topControls.appendChild(renderLeaveButton());
  topControls.appendChild(renderHardRefreshIconButton());
  topControls.appendChild(renderFullscreenButton());
  wrap.appendChild(topControls);

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
  const frozenIdsSet = computeFrozenIdsSet(game);
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
  // reasoning as poison/silence above. Reads state.pendingHeadacheVictimId
  // (broadcast explicitly by index.js's broadcastGameState), NOT
  // grimtal.special.headacheVictimId/headacheRollPending directly - the
  // roll resolves and clears those two flags SYNCHRONOUSLY the instant the
  // victim's own turn begins, before the server ever gets a chance to
  // broadcast the "still pending" state, so reading them straight off
  // `game` here could never actually catch the pending window in practice
  // (confirmed live report: "i have never seen headache status during
  // skull crush action"). The server now peeks the pending state and
  // emits one extra broadcast carrying it explicitly, one beat before the
  // resolving broadcast - see peekPendingHeadacheVictim/
  // broadcastGameState. pendingHeadacheVictimId is null on every OTHER
  // (resolving) broadcast, so this naturally reads false again the moment
  // the roll actually resolves - same one-shot, never-multi-turn behavior
  // as before, just now actually observable.
  const isDazedFor = (characterId) => state.pendingHeadacheVictimId === characterId;
  // Illyra's Mirage Mark - same "badge on the VICTIM's own tile" reasoning
  // as Kaelis's grudge badge above (a per-relationship stack count, not
  // something that fits cleanly on Illyra's own tile). mirageMarks arrives
  // as a plain object (Map -> Object.fromEntries, same sanitizeGameFor
  // Broadcast conversion as Rowan's silenceTargets).
  const illyra = Object.values(game.characters).find((c) => c.id === 'illyra');
  const mirageMarksFor = (characterId) => {
    if (!illyra || illyra.isKO || illyra.id === characterId) return 0;
    return illyra.special?.mirageMarks?.[characterId] || 0;
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
      mirageMarkCount: mirageMarksFor(character.id),
      isCursed: character.id === cursedId,
      isFrozenVisual: frozenIdsSet.has(character.id),
      isPuppet: character.id === puppetHighlightId || character.id === activePuppetId,
      isHypnotized: character.id === activePuppetId,
      isChicken: !!character.isChicken,
    }));
  });
  scroll.appendChild(board);

  const isMyTurn = mySeatCharacterIds.includes(actingCharacterId);
  const jb = game.jesterBall;
  const isMyBallDecision = isMyTurn && jb && jb.holderCharacterId === actingCharacterId;

  if (isMyBallDecision) {
    // Keep/Take (unlike Pass) deliberately do NOT consume the holder's
    // turn (see finishJesterBall, server/index.js/gameFlow.js) - Boingo
    // still owes his own normal action afterward, every time. Without
    // showing both panels together, he'd be stuck seeing only Keep/Pass
    // forever with no way to ever reach Chaos Gamble - confirmed live
    // report ("i can't keep it to use action"). Safe to show them
    // together regardless of client-side "has he acted yet" tracking
    // (which isn't broadcast anyway) - handleAction (server/index.js)
    // independently re-validates whose decision it actually still is via
    // settleToNextDecision before accepting anything.
    //
    // Always shown together, every time isMyBallDecision is true - an
    // earlier attempt hid this panel for "the rest of the turn" after a
    // Keep click (keyed on jesterBallKeptThisTurnFor === actingCharacterId)
    // but that flag couldn't tell "still this exact turn" apart from "a
    // LATER turn, same character acting again" - confirmed live report
    // ("after keep it prev round. how will i pass again"): once he'd
    // clicked Keep once, the panel silently never came back on ANY future
    // turn, permanently blocking Pass for the rest of the match. Reverted
    // rather than patched with a turn-instance key - the cosmetic
    // "buttons disappear right after Keep" polish isn't worth the risk of
    // this bug class recurring.
    scroll.appendChild(renderJesterBallPrompt(game, actingCharacterId, armedAction, state));
    scroll.appendChild(renderActionPanel(actingCharacterId, usableActions, armedAction, state));
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
    // A Guest watching a live match can jump into any bot-controlled seat
    // directly, taking over that character with its CURRENT state (hearts,
    // shield, everything) - confirmed ruling: no reconnect-token system at
    // all, a disconnected/left seat just becomes a bot immediately, and
    // claiming it mid-match is the only way back in (handleClaimSeat,
    // server-side). Not shown to a seated player (mySeatCharacterIds
    // non-empty would mean isMyTurn could still be false on someone else's
    // turn, but they already have their own seat - only offered to a bare
    // Guest, room.mySeatIndex === null).
    if (state.room?.youAreGuest) {
      const claimableSeats = (state.room.seats || []).filter((s) => s.kind === 'bot');
      if (claimableSeats.length > 0) {
        const claimSection = document.createElement('div');
        claimSection.className = 'claim-seat-section';
        const claimTitle = document.createElement('div');
        claimTitle.className = 'claim-seat-title';
        claimTitle.textContent = 'Take over a bot-controlled seat:';
        claimSection.appendChild(claimTitle);
        claimableSeats.forEach((seat) => {
          const btn = document.createElement('button');
          btn.className = 'claim-seat-btn';
          const seatCharNames = seat.characterIds.map((id) => CHARACTERS[id]?.name).filter(Boolean).join(' + ');
          btn.textContent = `Seat ${seat.index + 1}${seatCharNames ? ` (${seatCharNames})` : ''}`;
          btn.onclick = () => send('claim-seat', { seatIndex: seat.index });
          claimSection.appendChild(btn);
        });
        scroll.appendChild(claimSection);
      }
    }
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
// an odd, disconnected banner.
// Single, unconditional Leave button - no confirmation needed (unlike the
// old abandon-match flow this replaces): leaving only ever affects the
// leaver themselves. A seated player's seat converts to a bot immediately
// (same as any disconnect); a Guest or bots4 spectator just stops
// watching. No one can force-reset the match for anyone else (confirmed
// ruling) - the room's own lifecycle already tears itself down
// automatically once truly nobody real is left (see server's
// anyoneStillInRoom), so there's no separate manual "last one out, reset
// the room" action needed either.
function renderLeaveButton() {
  const btn = document.createElement('button');
  btn.className = 'exit-icon-btn';
  btn.title = 'Leave';
  btn.textContent = '🚪';
  btn.onclick = () => { playUiClick(); send('leave-room'); };
  return btn;
}

// Icon-only, same compact square style as fullscreen/exit - bumps the
// cache-busting version token and reloads immediately (see
// assetVersion.js's hardRefresh). One click, no confirmation: available
// mid-match too since stale-cached audio/images can surface here just as
// easily as on the entry screen. NOT low-stakes mid-match anymore though -
// there's no reconnect-token system (confirmed ruling), so reloading here
// disconnects the session and the seat converts to a bot immediately,
// same as closing the tab would. Getting back in requires rejoining the
// room by code as a Guest and claiming the now-bot seat (handleClaimSeat).
function renderHardRefreshIconButton() {
  const btn = document.createElement('button');
  btn.className = 'hard-refresh-btn';
  btn.title = 'Hard Refresh (fixes stuck/stale images or sounds)';
  btn.textContent = '🔄';
  btn.onclick = () => hardRefresh();
  return btn;
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
  const frozenIdsSet = computeFrozenIdsSet(game);
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
      isFrozenVisual: frozenIdsSet.has(character.id),
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

// Who's genuinely still frozen right now, from EITHER of Chronox's two
// freeze sources - same "driven off Chronox's ongoing active-flag state,
// NOT the target's skipNextTurn" reasoning as the main game's
// characterCard.js frozenCharacterId: skipNextTurn flickers back to false
// the instant a frozen turn is actually skipped, even though the freeze is
// still conceptually active until Chronox's own next turn resolves it.
// Time Freeze (freezeActive/freezeTargetId) is a single target;
// World Stops (worldStopsActive/worldStopsFrozenIds) can be several at
// once - both feed the same shared .ice-frozen visual, just from
// different underlying state shapes.
function computeFrozenIdsSet(game) {
  const chronox = Object.values(game.characters).find((c) => c.id === 'chronox');
  const ids = new Set();
  if (!chronox) return ids;
  if (chronox.special.freezeActive && chronox.special.freezeTargetId) {
    ids.add(chronox.special.freezeTargetId);
  }
  if (chronox.special.worldStopsActive) {
    for (const id of chronox.special.worldStopsFrozenIds || []) ids.add(id);
  }
  return ids;
}

function renderCharacterTile(character, { isActing, isMine, isTargetable, onTargetClick, isHoldingBall, isCursed, isFrozenVisual, isVictorious, isPuppet, isHypnotized, grudgeCount, isPoisoned, silencedTurns, isDazed, mirageMarkCount, isChicken }) {
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
  if (effects.has('shockmark') && !character.isKO) {
    // Chronox's Rewind: a bold "!" pops up over the attacker's tile whose
    // action just got undone - snap-in-and-bounce, reading as sudden
    // shock/disbelief, distinct from every other effect (nothing else uses
    // a plain glyph pop like this).
    const shock = document.createElement('div');
    shock.className = 'shock-mark-fx';
    shock.textContent = '!';
    tile.appendChild(shock);
  }
  if (effects.has('predictionwin') && !character.isKO) {
    // Oraclus's Rune Vision confirmed: a ring of rune stones snaps into a
    // tight orbit and blazes with a radiant cyan-white burst, reading as
    // "the vision was true" - escalating glow rather than a single pop,
    // distinct from every other win-flavored effect in this file (divine's
    // golden self-buff glow, revive's warm return-to-life burst).
    const win = document.createElement('div');
    win.className = 'prediction-win-fx';
    win.innerHTML = '<span class="prediction-rune prediction-rune--1"></span>' +
      '<span class="prediction-rune prediction-rune--2"></span>' +
      '<span class="prediction-rune prediction-rune--3"></span>' +
      '<span class="prediction-win-ring"></span>';
    tile.appendChild(win);
  }
  if (effects.has('predictionloss') && !character.isKO) {
    // Oraclus's Rune Vision failed: the same rune stones instead crack and
    // scatter, dimming from cyan to grey as they fall - a sharp, quick
    // shatter-and-fade, the visual inverse of predictionwin above (a
    // gathering ring vs. a scattering break).
    const loss = document.createElement('div');
    loss.className = 'prediction-loss-fx';
    loss.innerHTML = '<span class="prediction-shard prediction-shard--1"></span>' +
      '<span class="prediction-shard prediction-shard--2"></span>' +
      '<span class="prediction-shard prediction-shard--3"></span>';
    tile.appendChild(loss);
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
  if (effects.has('mirageshatter') && !character.isKO) {
    // Illyra's Mirage Burst detonation: a broken-glass shatter on each
    // victim, reading as their illusion cracking apart - riffs on Rowan's
    // mirror-shard shape (same fragment silhouette) but deliberately
    // RANDOMIZED (angle, size, count) each time it fires, per explicit
    // request ("random shatter animation"), and recolored to Illyra's own
    // violet palette rather than Rowan's silvery reflection tone, so the
    // two never read as the same effect even though they share a shape.
    const shatter = document.createElement('div');
    shatter.className = 'mirage-shatter-burst';
    const shardCount = 5 + Math.floor(Math.random() * 4); // 5-8 shards
    shatter.innerHTML = Array.from({ length: shardCount }, (_, i) => {
      const deg = Math.random() * 360;
      const dist = 32 + Math.random() * 20;
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(Math.cos(rad) * dist);
      const y = Math.round(Math.sin(rad) * dist);
      const size = 0.7 + Math.random() * 0.6;
      return `<span class="mirage-shard" style="--shard-x:${x}px; --shard-y:${y}px; --shard-scale:${size.toFixed(2)}; animation-delay:${(i * 0.025).toFixed(3)}s; rotate:${deg.toFixed(0)}deg;"></span>`;
    }).join('');
    tile.appendChild(shatter);
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
  if (effects.has('sacrificepierce') && !character.isKO) {
    // Athena's Divine Sacrifice, VICTIM side: a searing crimson-gold spear-
    // pierce gash flashes at the impact point, distinct from the plain
    // generic hit-flash every other landed attack gets - matches the
    // spear-fueled-by-her-own-blood language of her own cast image.
    const pierce = document.createElement('div');
    pierce.className = 'sacrifice-pierce-fx';
    pierce.innerHTML = '<span class="sacrifice-pierce-line"></span>' +
      '<span class="sacrifice-pierce-glow"></span>';
    tile.appendChild(pierce);
  }
  if (effects.has('bloodsacrifice') && !character.isKO) {
    // Athena's Divine Sacrifice: fires on HER OWN tile (not the enemy she
    // hit) - a few streaks of blood drip down from the top of the tile and
    // a brief red pulse, reading as "this cost her something" rather than
    // an incoming-hit flash (no one attacked her).
    const drip = document.createElement('div');
    drip.className = 'blood-sacrifice-fx';
    drip.innerHTML = '<span class="blood-drip blood-drip--1"></span>' +
      '<span class="blood-drip blood-drip--2"></span>' +
      '<span class="blood-drip blood-drip--3"></span>';
    tile.appendChild(drip);
  }
  if (effects.has('headspin') && !character.isKO) {
    // The whole tile itself visibly spins - distinct motion language from
    // every other effect here (none of which spin the CARD, only overlay
    // shapes on top of it). Two distinct triggers share this same visual:
    // Grimtal's Skull Crack headache (actual-skip outcome, reads as "too
    // dizzy to act") and, on the ATTACKER's own tile, a successful dodge
    // against Illyra's passive (reads as "missed so badly they're thrown
    // off balance") - see actionEffects.js's 'dodge' handler for the
    // Illyra-specific trigger.
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

  if (mirageMarkCount > 0 && !character.isKO) {
    // Illyra's Mirage Mark - same per-relationship badge reasoning as
    // Kaelis's grudge badge above.
    const mirage = document.createElement('div');
    mirage.className = 'mirage-mark-badge';
    mirage.textContent = `🪞${mirageMarkCount}`;
    mirage.title = `Illyra's Mirage Mark: ${mirageMarkCount} stack${mirageMarkCount > 1 ? 's' : ''} (her Mirage Burst on you would deal ${mirageMarkCount})`;
    tile.appendChild(mirage);
  }

  if (isChicken && !character.isKO) {
    // Boingo's Fowl Play - every currently-chickenified character shares
    // the SAME revert moment (once Boingo completes his own 3rd turn
    // since casting - see turnEngine.js's tickFowlPlayIfBoingoTurn), so
    // this is a plain on/off badge rather than a per-character countdown.
    // Top-center is the free badge slot (every corner already used,
    // bottom-center taken by Illyra's mirage badge).
    const chicken = document.createElement('div');
    chicken.className = 'chicken-badge';
    chicken.textContent = '🐔';
    chicken.title = "Chickenified by Boingo's Fowl Play - only Chicken Attack is available until Boingo has had 3 more of his own turns";
    tile.appendChild(chicken);
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
  } else if (character.isKO && character.isChicken) {
    // Boingo's Fowl Play - a chicken that gets KO'd shows the fried-
    // chicken gag art instead of that character's own normal koed.jpg.
    // Checked ahead of the plain isKO branch below since this is more
    // specific. isChicken staying true through a KO is intentional -
    // death doesn't clear it, only Boingo completing his own 3rd turn
    // since the cast does (see turnEngine.js's tickFowlPlayIfBoingoTurn),
    // so a chicken who dies mid-window keeps showing the roast art for
    // the rest of that window even though the match may already be over
    // for them.
    portrait.src = v('assets/images/boingo/chicken_roast.jpg');
  } else if (character.isKO) {
    portrait.src = v(`assets/koed/${character.id}.jpg`);
  } else if (character.isChicken) {
    // Boingo's Fowl Play - shared generic chicken art overrides this
    // character's own idle/injured portrait for as long as they're
    // chickenified, same "everything hidden" reasoning that also hides
    // their real action list (confirmed ruling: "chicken can only attack
    // ... other things will hide"). Checked ahead of the Draxus/injured
    // branches below since chicken status overrides both.
    portrait.src = v('assets/images/boingo/chicken.jpg');
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

  // Boingo's Fowl Play - the shield BADGE is hidden while chickenified
  // (confirmed ruling: "if hero has shield it will vanish on chiken
  // status. show again after curse over"), purely a display choice - the
  // real character.shield value underneath is completely untouched (same
  // "nothing pending is lost" rule as every other in-progress state, see
  // executeChickenAttack's own ignoresShield: true, which already makes
  // shield irrelevant to chicken-vs-chicken damage regardless of whether
  // the badge shows). Reappears automatically the instant isChicken flips
  // back to false, since this check just re-reads live state every render.
  if (character.shield > 0 && !character.isChicken) {
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

  // Boingo's Fowl Play - hidden while chickenified, same reasoning as the
  // shield badge above: untargetable status no longer actually protects
  // against a chicken attack (ignoresUntargetable: true), so showing the
  // badge would misleadingly claim a protection that isn't real anymore.
  if (character.untargetable && !character.isChicken) {
    const flag = document.createElement('div');
    flag.className = 'char-flag';
    flag.textContent = 'Untargetable';
    tile.appendChild(flag);
  }

  // Boingo's Fowl Play - every hero-resource badge (Rewind uses, Deathless
  // Fury active, streak count, etc.) is hidden while chickenified, same
  // "hero identity fully hidden" reasoning as the whole kit itself being
  // hidden - showing "Deathless Fury active" while chickenified would be
  // actively misleading now too, since the immortal floor no longer
  // protects against a chicken attack (ignoresImmortal: true).
  const badges = character.isChicken ? [] : statusBadges(character);
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
  // Tharox gets his own dedicated "N/2" badge below instead of the generic
  // one - Glory Smash is good for 2 casts per match (glorySmashesUsed),
  // and usedSpecial only flips true once BOTH are spent, so the generic
  // badge alone would only ever announce "fully out," never show a use
  // still in reserve after spending just one. Boingo's Jester Ball is back
  // to 1 throw per match (reverted from an earlier 2-throw buff), so the
  // generic badge below is accurate for him again - no dedicated case
  // needed.
  if (character.usedSpecial && character.id !== 'tharox') badges.push({ text: 'Special used', cls: 'warn' });
  switch (character.id) {
    case 'chronox':
      badges.push({ text: `Rewind: ${character.special.rewindUsesRemaining}/2` });
      // World Stops has its own dedicated usedWorldStops flag (separate
      // from usedSpecial, which Time Freeze owns) - only surfaced here
      // while its 2-round effect is actively ongoing (matching the action
      // button list, not this badge row, being the source of truth for
      // "is it available to cast right now" - a pre-threshold "ready"
      // badge would misleadingly imply it's castable before hearts <= 3
      // actually applies).
      if (character.special.worldStopsActive) {
        badges.push({ text: 'World Stops active', cls: 'warn' });
      }
      break;
    case 'tharox':
      if (character.special.hasCharge) badges.push({ text: 'Charge ready', cls: 'warn' });
      badges.push({ text: `Glory Smash: ${character.special.glorySmashesUsed}/2` });
      break;
    case 'zerathys':
      // Overcharge Collapse (Passive Action #23, no button - see
      // zerathys.js) - while hearts <= 3, Charge Up is hidden and Thunder
      // Wrath always hits for a flat 3 regardless of chargeCount, so
      // showing the normal "Charge: X/2" badge here would be actively
      // misleading (implying charge still matters when it doesn't).
      if (character.hearts <= 3) {
        badges.push({ text: 'Overcharged (Thunder Wrath: 3)', cls: 'warn' });
      } else {
        badges.push({ text: `Charge: ${character.special.chargeCount}/2` });
      }
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
    case 'grimtal': {
      // Skull Crack: 3 total casts per match - shown as REMAINING/3 (not
      // used/3, unlike Boingo's Jester Ball badge above), so the number
      // counts down to 0 as he spends them, matching how a limited-use
      // resource reads most intuitively at a glance.
      const remaining = 3 - character.special.skullCrackUsed;
      badges.push({ text: `Skull Crack: ${remaining}/3` });
      if (character.special.unclaimedKillCount > 0) {
        badges.push({ text: `💀 ${character.special.unclaimedKillCount}`, cls: 'warn', title: 'Unclaimed kills banked - cast Claim the Kill to convert into permanent power' });
      }
      break;
    }
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
  title.textContent = state.awaitingSoulSwapWrath
    ? 'Soul Swap landed - choose your free Thunder Wrath target'
    : state.awaitingRuneVisionTarget
      ? 'Rune Vision: who will they strike?'
      : 'Your turn - choose an action';
  panel.appendChild(title);

  // Skipped for the Soul Swap free follow-up and Rune Vision's stage 2
  // (awaitingSoulSwapWrath/awaitingRuneVisionTarget) - both are a forced,
  // already-in-motion continuation of the turn, not a fresh decision that
  // needs its own "look before you act" beat.
  const lockoutUntil = (!state.awaitingSoulSwapWrath && !state.awaitingRuneVisionTarget && state.turnDeadline)
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
  } else if (state.awaitingRuneVisionTarget) {
    send('rune-vision-target-pick', { characterId, targetId });
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

  // Take deals its 4 damage to WHOEVER'S HOLDING IT - for Boingo that
  // would mean exploding his own ball on himself for a flat -4 with zero
  // upside, since he's the one whose whole special is built around this
  // ball being GOOD for him. Genuinely never a sensible choice for him, so
  // the button is hidden entirely rather than just being a trap option -
  // confirmed live report ("why is this showing on boingo"). He only ever
  // gets Pass here (no dedicated Keep button either - removed 2026-08-31,
  // confirmed redundant: Keep was a pure no-op server-side, so a human
  // could already get the identical effect by simply picking his normal
  // action, e.g. Chaos Gamble, directly instead of resolving the ball at
  // all that turn).
  if (characterId !== 'boingo') {
    const takeBtn = document.createElement('button');
    takeBtn.textContent = 'Take it (-4 hearts)';
    takeBtn.onclick = () => send('jester-ball-choice', { characterId, choice: 'take' });
    btnRow.appendChild(takeBtn);
  }

  // Passing is now repeatable up to 10 times (jb.passCount, raised from 5 -
  // confirmed ruling alongside the Boingo-toll-booth rework) - there's no
  // separate "Return to Boingo" button anymore, since passing TO Boingo
  // (now a legal target, see below) is what grants his checkpoint heal (or
  // the full +4 if it's the final pass), same outcome as the old dedicated
  // Return choice just reached via Pass instead.
  if (jb.passCount < 10) {
    const passBtn = document.createElement('button');
    passBtn.textContent = `Pass to another player (${10 - jb.passCount} left)`;
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

// Formats one entry's end-action hearts/shield snapshot (see turnEngine.js's
// heartsSnapshot - {hearts, shield} per living character, or the string
// 'KO') into a compact "Name:H/S" readout, sorted by character id for a
// stable column-like order. Appended to each real event's own text line
// (2026-08-30, user request) so a pasted match log can be hand-traced/
// verified directly against the numbers shown, without needing a fresh
// code investigation every time a damage-arithmetic bug is suspected.
function formatHeartsSnapshot(snapshot) {
  if (!snapshot) return '';
  const parts = Object.keys(snapshot).sort().map((id) => {
    const s = snapshot[id];
    const label = CHARACTERS[id]?.name || id;
    if (s === 'KO') return `${label}:KO`;
    return `${label}:${s.hearts}${s.shield > 0 ? `+${s.shield}sh` : ''}`;
  });
  return parts.join(' ');
}

// Full, uncapped match log for the game-over screen (unlike renderLog's
// live 20-line window during play) - the whole point here is a permanent
// record of exactly what happened, in the order it happened, that the
// winner/loser can copy out and keep or share. Each real event line is
// suffixed with a [Name:H+Ssh ...] readout of every character's hearts/
// shield right after THAT SPECIFIC entry resolved.
//
// Server-side (2026-08-30), every log entry that's pushed STANDALONE -
// outside executeAction/finalizeAction's own batching (gameFlow.js's turn-
// skip branches, chronox.js/kaelis.js/marin.js/draxus.js's onTurnStart
// passives, turnEngine.js's tick helpers, index.js's Rune-Vision-stage-2/
// timeout messages) - now stamps its own hearts snapshot directly at push
// time (see damagePipeline.js's heartsSnapshot). This was a real, confirmed
// display bug before that fix: the ORIGINAL version of this function scanned
// forward for the next 'end-action' marker's snapshot for every entry
// uniformly, which was WRONG for any standalone entry (no end-action of its
// own to find) - it would silently borrow a LATER, unrelated action's
// snapshot instead, showing damage/shield changes on lines with no action
// logged against that character at all. Confirmed via a live match log.
// Purely a display bug; no combat-resolution damage was ever misapplied.
//
// The entries that DON'T carry their own hearts field are exactly the ones
// that were always correctly bundled: an action's main attack/special/dodge
// line, still pushed into an execute()-local `log` array that finalizeAction
// later bundles as one batch ending in a single shared 'end-action' marker.
// For those (and only those - every standalone site above is now covered),
// the forward-scan to that batch's own end-action is legitimate and safe.
function renderFullLogWithCopy(log) {
  const lines = [];
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    if (entry.type === 'end-action') continue;
    const text = describeLogEntry(entry);
    if (!text) continue;
    let hearts = entry.hearts;
    if (!hearts) {
      for (let j = i + 1; j < log.length; j++) {
        if (log[j].type === 'end-action') { hearts = log[j].hearts; break; }
        if (log[j].hearts) break; // hit the next STANDALONE entry's own snapshot first - stop, don't borrow past it
      }
    }
    const snapshotText = formatHeartsSnapshot(hearts);
    lines.push(snapshotText ? `${text}  [${snapshotText}]` : text);
  }
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

// Describes which status-block mechanic actually intercepted a
// curse/mark/freeze/silence/headache attempt - reads entry.blockedBy
// (confirmed bug fix, 2026-09-01: every status-application site used to
// log an ambiguous `blocked: true` regardless of whether Marin's Clean
// Slate or Illyra's Illusion passive actually fired, so this text always
// said "blocked by Clean Slate!" even in matches Marin wasn't even in -
// live report traced this exact mislabeling against Illyra's own dodge).
// Returns '' for anything that landed normally (blockedBy null/undefined).
function blockedByText(blockedBy) {
  if (blockedBy === 'cleanSlate') return ' - blocked by Clean Slate!';
  if (blockedBy === 'illyra') return ' - blocked by Illusion!';
  return '';
}

// Generic fallback for any ability whose log entry's own `targetId` (the
// player's original choice) could ever diverge from applyDamage's own
// result `targetCharacterId` (the actual outcome, spread in via
// `...result`) - not currently used by any live redirect mechanic, but
// kept as the safe default every attack-line formatter below reads
// through, so a future redirect-shaped ability doesn't need to re-thread
// this same fallback into each call site again. Falls back to
// entry.targetId whenever targetCharacterId is absent (non-applyDamage
// entries) or matches it anyway (the common case).
function actualAttackTargetId(entry) {
  return entry.targetCharacterId ?? entry.targetId;
}

// Mirrors each ability's `label` field server-side (abilities/*.js) - kept
// as a client-side lookup rather than plumbed through every log entry,
// since action ids are stable, non-secret game data.
const ACTION_LABELS = {
  cyclonePunch: 'Cyclone Punch', timeFreeze: 'Time Freeze', rewind: 'Rewind', worldStops: 'World Stops',
  smash: 'Smash', titanToss: 'Titan Toss', titanSmash: 'Titan Smash', glorySmash: 'Glory Smash', earthshatter: 'Earthshatter',
  chargeUp: 'Charge Up', thunderWrath: 'Thunder Wrath', soulSwap: 'Soul Swap', soulSwapWrath: 'Thunder Wrath (free)',
  hiddenMark: 'Hidden Mark', fatalSlash: 'Fatal Slash', shadowExecution: 'Shadow Execution',
  lunarStrike: 'Lunar Strike', moonstep: 'Moonstep', lunarEclipse: 'Lunar Eclipse',
  chaosGamble: 'Chaos Gamble', jesterBall: 'Jester Ball', fowlPlay: 'Fowl Play', chickenAttack: 'Chicken Attack', bloodHunt: 'Blood Hunt',
  curseStrike: 'Curse Strike', divineRestore: 'Divine Restore', divineSacrifice: 'Divine Sacrifice',
  selfChoke: 'Self Choke',
  grudgeStrike: 'Grudge Strike', callAshka: 'Call Ashka',
  dyingBlow: 'Dying Blow', deathlessFury: 'Deathless Fury',
  wandStrike: 'Wand Strike', arcaneStudy: 'Arcane Study',
  poisonCloud: 'Poison Cloud', purify: 'Purify', wildLightning: 'Wild Lightning',
  mirrorReflect: 'Mirror Reflect', silenceLock: 'Silence Lock',
  everbloom: 'Everbloom', threefoldVeil: 'Threefold Veil', cleanSlate: 'Clean Slate',
  piercingWand: 'Piercing Wand', wandMastery: 'Wand Mastery',
  grimStrike: 'Grim Strike', skullCrack: 'Skull Crack', claimKill: 'Claim the Kill', grimBarrage: 'Grim Barrage',
  mirageMark: 'Mirage Mark', mirageBurst: 'Mirage Burst', mirageOverload: 'Mirage Overload',
  runeStrike: 'Rune Strike', runeVision: 'Rune Vision', runeVisionTargetPick: 'Rune Vision',
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
    case 'mind-control-resist':
      return `${name(entry.puppetCharacterId)}'s will resists ${name(entry.characterId)}'s control - ${actionLabel(entry.actionId)} fails!`;
    case 'attack':
      if (entry.actionId === 'divineSacrifice') {
        // Shows both sides of the gamble - the guaranteed 3 dealt to the
        // enemy AND the random hearts it actually cost her this cast,
        // including if it happened to KO her too.
        return `${name(entry.characterId)} used ${actionLabel(entry.actionId)} on ${name(actualAttackTargetId(entry))}${entry.amountDealt != null ? ` - ${entry.amountDealt} damage` : ''}${entry.koTriggered ? ' - KO!' : ''} (sacrificed ${entry.selfCost} heart${entry.selfCost > 1 ? 's' : ''}${entry.selfResult?.koTriggered ? ' - KO!' : ''})`;
      }
      return `${name(entry.characterId)} used ${actionLabel(entry.actionId)} on ${name(actualAttackTargetId(entry))}${entry.amountDealt != null ? ` - ${entry.amountDealt} damage` : ''}${entry.koTriggered ? ' - KO!' : ''}`;
    case 'special':
      if (entry.actionId === 'fowlPlay') {
        const victims = entry.chickenIds || [];
        return `${name(entry.characterId)} unleashed Fowl Play - ${victims.map(name).join(', ')} turned into chickens!`;
      }
      if (entry.actionId === 'mirageBurst') {
        // No single target - detonates everyone currently marked at once,
        // each for their own stack count. Lists every victim who actually
        // had something to burst (entry.bursts is empty if she somehow
        // cast this with nothing marked, though isLegal should prevent
        // that from ever happening).
        if (!entry.bursts || entry.bursts.length === 0) {
          return `${name(entry.characterId)} used Mirage Burst - nothing was marked!`;
        }
        const parts = entry.bursts.map((b) =>
          `${name(b.targetId)} (${b.stackCount} stack${b.stackCount > 1 ? 's' : ''}${b.amountDealt != null ? `, ${b.amountDealt} dmg` : ''}${b.koTriggered ? ' - KO!' : ''})`
        );
        return `${name(entry.characterId)} used Mirage Burst - detonated ${parts.join(', ')}`;
      }
      if (entry.actionId === 'mirageOverload') {
        const landed = Object.entries(entry.landedOn || {});
        const parts = landed.map(([tid, count]) => `${name(tid)} (+${count})`);
        return `${name(entry.characterId)} unleashed Mirage Overload - scattered ${entry.totalStacks} mirage stacks: ${parts.join(', ')}`;
      }
      if (entry.actionId === 'earthshatter') {
        // No single target - scatters a flat 7 damage points randomly
        // across every alive opponent at once, so list every victim who
        // actually took a hit (entry.hits is empty only if he somehow cast
        // this with zero living opponents, though that shouldn't be
        // reachable in real play).
        if (!entry.hits || entry.hits.length === 0) {
          return `${name(entry.characterId)} unleashed Earthshatter - the ground cracked, but no one was left to hit!`;
        }
        const parts = entry.hits.map((h) =>
          `${name(h.targetId)} (${h.amountDealt != null ? `${h.amountDealt} dmg` : '0 dmg'}${h.koTriggered ? ' - KO!' : ''})`
        );
        return `${name(entry.characterId)} unleashed Earthshatter - ${parts.join(', ')}`;
      }
      if (entry.actionId === 'grimBarrage') {
        // 3 independent random-target hits (not pre-aggregated points like
        // Earthshatter) - each entry in entry.hits is its own separate
        // swing, so the SAME target can legitimately appear more than once
        // if the random assignment landed on them repeatedly.
        if (!entry.hits || entry.hits.length === 0) {
          return `${name(entry.characterId)} unleashed Grim Barrage - the barrage found no one left to strike!`;
        }
        const parts = entry.hits.map((h) =>
          `${name(h.targetId)} (${h.amountDealt != null ? `${h.amountDealt} dmg` : '0 dmg'}${h.koTriggered ? ' - KO!' : ''}${h.blockedBy ? `, headache blocked by ${h.blockedBy === 'cleanSlate' ? 'Clean Slate' : 'Illusion'}` : ''})`
        );
        return `${name(entry.characterId)} unleashed Grim Barrage - ${parts.join(', ')}`;
      }
      if (entry.actionId === 'runeVision') {
        if (entry.stage === 1) {
          // Deliberately vague about the PREDICTED TARGET here - only the
          // attacker pick is public at this stage (matches Akyros's Hidden
          // Mark's own "no target named" precedent for a secret setup
          // move), the full guess is only revealed once it resolves via
          // the 'prediction-result' entry below.
          return `${name(entry.characterId)} cast Rune Vision, predicting ${name(entry.predictedAttackerId)} will strike...`;
        }
        return `${name(entry.characterId)} predicts ${name(entry.predictedAttackerId)} will strike ${name(entry.predictedTargetId)}`;
      }
      if (entry.actionId === 'rewind') {
        // Jester Ball explosions record no caster (see server's
        // resolveJesterBall) - describe it as undoing the explosion itself
        // rather than crediting it to a specific attacker.
        if (entry.rewoundCasterId === null) {
          return `${name(entry.characterId)} used Rewind - undid the Jester Ball explosion!`;
        }
        return `${name(entry.characterId)} used Rewind - undid ${name(entry.rewoundCasterId)}'s ${actionLabel(entry.rewoundActionId)}!`;
      }
      if (entry.actionId === 'worldStops') {
        // No single targetId (freezes everyone at once) - list who actually
        // got frozen, and separately call out anyone Clean Slate blocked
        // (the one thing that can still resist it - see chronox.js's
        // worldStops.isLegal/execute comments).
        const frozenText = entry.frozenIds.length > 0
          ? `froze ${entry.frozenIds.map(name).join(', ')}`
          : 'froze no one';
        const blockedText = entry.blockedIds && entry.blockedIds.length > 0
          ? ` (${entry.blockedIds.map(name).join(', ')} blocked by Clean Slate)`
          : '';
        return `${name(entry.characterId)} unleashed World Stops - ${frozenText}${blockedText}`;
      }
      return `${name(entry.characterId)} used their SPECIAL: ${actionLabel(entry.actionId)}${entry.targetId ? ` on ${name(actualAttackTargetId(entry))}` : ''}${blockedByText(entry.blockedBy)}`;
    case 'setup':
      if (entry.actionId === 'mirageMark') {
        return `${name(entry.characterId)} used Mirage Mark on ${name(entry.targetId)} - ${entry.stackCount} stack${entry.stackCount > 1 ? 's' : ''}`;
      }
      return `${name(entry.characterId)} used ${actionLabel(entry.actionId)}${entry.chargeCount ? ` (${entry.chargeCount}/2)` : ''}`;
    case 'hidden-mark':
      // Previously always read "placed a Hidden Mark" even when it was
      // actually blocked (confirmed bug, 2026-09-01) - the client never
      // displayed the block at all for this entry type, so a failed
      // attempt silently read as a successful one.
      return `${name(entry.characterId)} placed a Hidden Mark${blockedByText(entry.blockedBy)}`;
    case 'curse':
      return `${name(entry.characterId)} cast Curse Strike on ${name(entry.targetId)}${blockedByText(entry.blockedBy)}`;
    case 'curse-mirror':
      return `Curse mirrors ${entry.amount} damage to ${name(entry.toCharacterId)}${entry.koTriggered ? ' - KO!' : ''}`;
    case 'ashka-heal':
      return `${name(entry.characterId)}'s Ashka heals +${entry.healed}`;
    case 'prediction-result':
      return entry.matched
        ? `Rune Vision confirmed! ${name(entry.predictedAttackerId)} struck ${name(entry.predictedTargetId)} exactly as foreseen - +3 hearts, +3 shield, +1 damage (${entry.predictionWins}/2 wins)`
        : `Rune Vision failed - the vision did not come to pass`;
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
    case 'world-stops-continue':
      return `World Stops continues - ${entry.frozenIds.map(name).join(', ')} still frozen`;
    case 'world-stops-end':
      return `World Stops ends - time resumes for everyone`;
    case 'fowl-play-revert': {
      const revertedNames = (entry.characterIds || []).map(name);
      return `${revertedNames.join(', ')} turn${revertedNames.length === 1 ? 's' : ''} back into ${revertedNames.length === 1 ? 'a hero' : 'heroes'}!`;
    }
    case 'eclipse-end':
      return `${name(entry.characterId)}'s Lunar Eclipse ends`;
    case 'jester-ball-take':
      return `${name(entry.targetCharacterId)} took the Jester Ball${entry.amountDealt != null ? ` - -${entry.amountDealt} hearts` : ''}`;
    case 'jester-ball-pass':
      return `${name(entry.fromCharacterId)} passed the Jester Ball to ${name(entry.toCharacterId)}`;
    case 'jester-ball-return': {
      const parts = [];
      if (entry.healed) parts.push(`healed ${entry.healed}`);
      if (entry.shielded) parts.push(`+${entry.shielded} shield`);
      return `Jester Ball returned to ${name(entry.boingoId)}${parts.length ? ` - ${parts.join(', ')}` : ''}`;
    }
    case 'jester-ball-checkpoint-heal': {
      const parts = [];
      if (entry.healed) parts.push(`healed ${entry.healed}`);
      if (entry.shielded) parts.push(`+${entry.shielded} shield`);
      return `The Jester Ball passes through ${name(entry.boingoId)}${parts.length ? ` - ${parts.join(', ')}` : ''}`;
    }
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
