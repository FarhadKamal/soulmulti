import { connect, onMessage } from './net.js';
import { renderLobby } from './lobbyScreen.js';
import { renderBattle } from './battleScreen.js';
import { addChatMessage } from './chatPanel.js';
import {
  startMenuMusic, startBattleMusic, stopMusic,
  playActionSound, playKO, playVictory, playDodge, playRebirth,
} from './sound.js';
import { handleLogEntryForFlash, handleDodgeForFlash, checkIdlePortrait, registerFlashRerender } from './portraitFlash.js';

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
  rerender,
};

// Tracks how much of game.log has already been "heard" so incoming
// game-state broadcasts only react to genuinely NEW entries, not the whole
// log again on every update. Also tracks the previously-acting character
// to detect "a new character's turn just started" for the idle-portrait
// check (see portraitFlash.js's checkIdlePortrait).
let lastLogLength = 0;
let previousActingCharacterId = null;

function processNewLogEntries(game) {
  const newEntries = game.log.slice(lastLogLength);
  lastLogLength = game.log.length;
  for (const entry of newEntries) {
    if (entry.type === 'attack' || entry.type === 'special') {
      playActionSound(entry.actionId);
      if (entry.koTriggered) setTimeout(() => playKO(), 200);
    } else if (entry.type === 'dodge') {
      playDodge();
    } else if (entry.type === 'rebirth') {
      playRebirth();
    } else if (entry.type === 'curse-mirror' && entry.koTriggered) {
      setTimeout(() => playKO(), 200);
    } else if (entry.type === 'jester-ball-take') {
      playActionSound('jesterBall');
      if (entry.koTriggered) setTimeout(() => playKO(), 200);
    }
    handleLogEntryForFlash(entry, game);
    handleDodgeForFlash(entry, game);
  }
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
      }
      rerender();
      break;
    case 'game-state':
      if (state.screen !== 'battle') startBattleMusic();
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
      if (msg.game.phase === 'game-over') playVictory();
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
connect();
rerender();
startMenuMusic();
