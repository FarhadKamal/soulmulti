import { connect, onMessage } from './net.js';
import { renderLobby } from './lobbyScreen.js';
import { renderBattle } from './battleScreen.js';
import { addChatMessage } from './chatPanel.js';
import {
  startMenuMusic, startBattleMusic, stopMusic,
  playActionSound, playSound, playKO, playVictory, playDodge, playRebirth, playCoin,
} from './sound.js';
import { handleLogEntryForFlash, handleDodgeForFlash, checkIdlePortrait, registerFlashRerender } from './portraitFlash.js';
import { handleLogEntryForEffects, registerEffectRerender } from './actionEffects.js';

const root = document.getElementById('app');

const state = {
  screen: 'lobby', // 'lobby' | 'battle'
  room: null,
  error: null,
  connectionLost: false,
  game: null,
  actingCharacterId: null,
  usableActions: [],
  awaitingSoulSwapWrath: false,
  armedAction: null,
  confirmingExit: false,
  turnDeadline: null,
  humanCount: null,
  // Staged game-over transition, mirroring the main game's own
  // gameOverBannerShown/showVictoryArt sequence: 'freeze' (board stays up
  // so the winning action's flash/shake/portrait is actually seen, not cut
  // away from instantly) -> 'victory' (winning character(s) art) ->
  // 'banner' (the actual Match Over screen). null while not in game-over.
  gameOverStage: null,
  rerender,
};

// Tracks how much of game.log has already been "heard" so incoming
// game-state broadcasts only react to genuinely NEW entries, not the whole
// log again on every update. Also tracks the previously-acting character
// to detect "a new character's turn just started" for the idle-portrait
// check (see portraitFlash.js's checkIdlePortrait).
let lastLogLength = 0;
let previousActingCharacterId = null;

// Guards the game-over timer chain (see startGameOverSequence below) so a
// repeat game-state broadcast or an unrelated rerender (e.g. a chat
// message arriving) while already mid-sequence doesn't stack a second,
// independent set of setTimeouts on top of the first one.
let gameOverSequenceStarted = false;

// Same staged reveal as the main game's dashboardScreen.js render(): freeze
// on the live board first (so the winning action's own flash/shake/
// portrait effect is actually seen, matching actionEffects.js's own
// 1600ms-ish timers rather than being cut away from instantly), then show
// victory art, then finally the Match Over banner. ~1.2s + ~3.8s, same
// total as the main game's own two-stage delay.
function startGameOverSequence() {
  if (gameOverSequenceStarted) return;
  gameOverSequenceStarted = true;
  state.gameOverStage = 'freeze';
  setTimeout(() => {
    if (state.screen !== 'battle') return; // torn down (left the room) mid-sequence
    state.gameOverStage = 'victory';
    rerender();
    setTimeout(() => {
      if (state.screen !== 'battle') return;
      state.gameOverStage = 'banner';
      playVictory();
      rerender();
    }, 3800);
  }, 1200);
}

function processNewLogEntries(game) {
  const newEntries = game.log.slice(lastLogLength);
  lastLogLength = game.log.length;
  for (const entry of newEntries) {
    playLogEntrySound(entry);
    handleLogEntryForFlash(entry, game);
    handleDodgeForFlash(entry, game);
    handleLogEntryForEffects(entry, game);
  }
}

// Mirrors the main game's playPostActionSounds/finishJesterBall sound
// dispatch exactly - same priority order (rebirth beats dodge beats the
// normal action sound, since an ability that revives or gets dodged never
// also plays its own hit sound on top), same per-actionId special cases
// (Cyclone Punch's extra coin-flip sound, Chaos Gamble's distinct miss
// sound on a losing roll), and the same four distinct Jester Ball
// resolution sounds (throw/pass/take-explode-or-revive/return) instead of
// reusing one sound for all of them.
function playLogEntrySound(entry) {
  if (entry.type === 'dodge') {
    playDodge();
    return;
  }
  if (entry.type === 'rebirth') {
    playRebirth();
    return;
  }
  if (entry.type === 'curse-mirror') {
    if (entry.koTriggered) setTimeout(() => playKO(), 200);
    return;
  }
  if (entry.type === 'jester-ball-pass') {
    playSound('kick');
    return;
  }
  if (entry.type === 'jester-ball-return') {
    playSound('magic');
    return;
  }
  if (entry.type === 'jester-ball-take') {
    // Explodes on the holder (smash) UNLESS it triggered Blade's Rebirth
    // instead - that case gets its own dedicated 'rebirth' entry right
    // after this one (handled above), so skip the explosion sound here to
    // avoid playing both for the same event.
    if (!entry.revived) {
      playSound('smash');
      if (entry.koTriggered) setTimeout(() => playKO(), 200);
    }
    return;
  }
  // Curse Strike ('curse') and Hidden Mark ('hidden-mark') each log their
  // own dedicated type rather than 'attack'/'special'/'setup' - same
  // reasoning as portraitFlash.js's equivalent branches - so they need
  // their own actionId here too, since the generic dispatch below only
  // ever sees 'attack'/'special'/'setup' entries.
  if (entry.type === 'curse') {
    playActionSound('curseStrike');
    return;
  }
  if (entry.type === 'hidden-mark') {
    playActionSound('hiddenMark');
    return;
  }
  if (entry.type !== 'attack' && entry.type !== 'special' && entry.type !== 'setup') return;

  // A dodged hit already got its own 'dodge' log entry (and playDodge()
  // above) - the ability's own attack/special entry still gets pushed
  // alongside it (with dodged:true, amountDealt 0), but per the main
  // game's playPostActionSounds, dodge and the normal action sound are
  // mutually exclusive, not layered.
  if (entry.dodged) return;

  if (entry.actionId === 'cyclonePunch') playCoin();
  if (entry.actionId === 'chaosGamble' && entry.outcome === 'lose') {
    playSound('miss');
    return;
  }
  playActionSound(entry.actionId);
  if (entry.koTriggered) setTimeout(() => playKO(), 200);
}

function mySeatCharacterIds() {
  if (!state.room || state.room.mySeatIndex === null) return [];
  return state.room.seats[state.room.mySeatIndex]?.characterIds || [];
}

function rerender() {
  if (state.screen === 'lobby') {
    renderLobby(root, { room: state.room, error: state.error, connectionLost: state.connectionLost }, {
      onEnterMatch: () => { state.screen = 'battle'; rerender(); },
    });
  } else {
    // Pass the REAL state object through (not a fresh literal) - battleScreen
    // mutates state.armedAction directly (e.g. arming a targeted action, or
    // Jester Ball's Pass target-pick mode) and expects that mutation to
    // stick across the next rerender(). An earlier version built a new
    // object literal here each call, which meant those mutations landed on
    // a throwaway copy and got silently discarded - clicking any action
    // that needs a target (i.e. everything except Charge Up) appeared to do
    // nothing, since armedAction always reset back to whatever main.js's
    // real state had, never what the click just set.
    state.mySeatCharacterIds = mySeatCharacterIds();
    renderBattle(root, state);
  }
}

onMessage((msg) => {
  switch (msg.type) {
    case 'session':
      break; // net.js tracks this internally
    case 'room-created':
    case 'room-joined':
      state.error = null;
      break;
    case 'lobby-update':
      state.room = msg.room;
      state.error = null;
      // A lobby-update while the room's phase is back to 'lobby' means the
      // owner sent return-to-lobby (after a match ended) or abandon-match
      // (mid-match), or this is just the normal pre-match flow - either
      // way, the battle screen should stop showing (it has no way to
      // update itself once the server's game object is gone / a new match
      // hasn't started yet).
      if (msg.room.phase === 'lobby') {
        if (state.screen !== 'lobby') startMenuMusic();
        state.screen = 'lobby';
        lastLogLength = 0; // next match starts a fresh game.log from []
        previousActingCharacterId = null;
        gameOverSequenceStarted = false; // next match gets its own fresh sequence
        state.gameOverStage = null;
      } else if (msg.room.phase === 'in-match' && state.screen !== 'battle') {
        // lobbyScreen.js's onEnterMatch flips state.screen to 'battle' the
        // instant it sees room.phase 'in-match' here, BEFORE the first
        // game-state broadcast for the new match arrives - so the
        // `state.screen !== 'battle'` check that used to gate
        // startBattleMusic() inside the 'game-state' case below was always
        // false by the time that broadcast landed (screen had already
        // flipped here), and battle music never started, leaving menu
        // music playing through the whole match. Start it here instead, at
        // the actual moment the screen transition happens.
        startBattleMusic();
      }
      rerender();
      break;
    case 'game-state':
      state.screen = 'battle';
      state.game = msg.game;
      state.actingCharacterId = msg.actingCharacterId;
      state.usableActions = msg.usableActions || [];
      state.awaitingSoulSwapWrath = !!msg.awaitingSoulSwapWrath;
      state.armedAction = null;
      state.confirmingExit = false;
      state.turnDeadline = msg.turnDeadline || null;
      state.humanCount = msg.humanCount ?? null;
      processNewLogEntries(msg.game);
      // A fresh turn just started for whoever's now acting (different from
      // who was acting on the previous broadcast) - check their idle
      // portrait (Athena's apple, Velorya's dance, etc.) the same moment
      // the main game's beginCharacterTurn hook does.
      if (msg.actingCharacterId && msg.actingCharacterId !== previousActingCharacterId) {
        const character = msg.game.characters[msg.actingCharacterId];
        if (character) checkIdlePortrait(character);
      }
      previousActingCharacterId = msg.actingCharacterId;
      if (msg.game.phase === 'game-over') startGameOverSequence();
      rerender();
      break;
    case 'error':
      state.error = msg.message;
      rerender();
      break;
    case 'connection-closed':
      state.error = 'Connection lost.';
      state.connectionLost = true;
      stopMusic();
      rerender();
      break;
    case 'left-room':
      // Confirmation that leave-room was processed - reset back to the
      // entry screen (create/join), same connection stays open.
      state.screen = 'lobby';
      state.room = null;
      state.game = null;
      state.error = null;
      lastLogLength = 0;
      previousActingCharacterId = null;
      startMenuMusic();
      rerender();
      break;
    case 'chat-message':
      addChatMessage(msg);
      rerender();
      break;
    default:
      break;
  }
});

registerFlashRerender(() => { if (state.screen === 'battle') rerender(); });
registerEffectRerender(() => { if (state.screen === 'battle') rerender(); });
connect();
rerender();
startMenuMusic();
