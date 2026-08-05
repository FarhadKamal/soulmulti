import { connect, onMessage } from './net.js';
import { renderLobby } from './lobbyScreen.js';
import { renderBattle } from './battleScreen.js';
import { addChatMessage } from './chatPanel.js';

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
  turnDeadline: null,
  rerender,
};

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
      // owner sent return-to-lobby after a match ended (or this is the
      // normal pre-match flow) - either way, the battle screen should stop
      // showing (it has no way to update itself once the server's game
      // object is gone / a new match hasn't started yet).
      if (msg.room.phase === 'lobby') state.screen = 'lobby';
      rerender();
      break;
    case 'game-state':
      state.screen = 'battle';
      state.game = msg.game;
      state.actingCharacterId = msg.actingCharacterId;
      state.usableActions = msg.usableActions || [];
      state.awaitingSoulSwapWrath = !!msg.awaitingSoulSwapWrath;
      state.armedAction = null;
      state.turnDeadline = msg.turnDeadline || null;
      rerender();
      break;
    case 'error':
      state.error = msg.message;
      rerender();
      break;
    case 'connection-closed':
      state.error = 'Connection lost.';
      state.connectionLost = true;
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

connect();
rerender();
