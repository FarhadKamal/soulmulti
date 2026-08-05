import { connect, onMessage } from './net.js';
import { renderLobby } from './lobbyScreen.js';
import { renderBattle } from './battleScreen.js';
import { addChatMessage } from './chatPanel.js';

const root = document.getElementById('app');

const state = {
  screen: 'lobby', // 'lobby' | 'battle'
  room: null,
  error: null,
  game: null,
  actingCharacterId: null,
  usableActions: [],
  awaitingSoulSwapWrath: false,
  armedAction: null,
  rerender,
};

function mySeatCharacterIds() {
  if (!state.room || state.room.mySeatIndex === null) return [];
  return state.room.seats[state.room.mySeatIndex]?.characterIds || [];
}

function rerender() {
  if (state.screen === 'lobby') {
    renderLobby(root, { room: state.room, error: state.error }, {
      onEnterMatch: () => { state.screen = 'battle'; rerender(); },
    });
  } else {
    renderBattle(root, {
      game: state.game,
      actingCharacterId: state.actingCharacterId,
      usableActions: state.usableActions,
      awaitingSoulSwapWrath: state.awaitingSoulSwapWrath,
      armedAction: state.armedAction,
      mySeatCharacterIds: mySeatCharacterIds(),
      rerender,
    });
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
      rerender();
      break;
    case 'game-state':
      state.screen = 'battle';
      state.game = msg.game;
      state.actingCharacterId = msg.actingCharacterId;
      state.usableActions = msg.usableActions || [];
      state.awaitingSoulSwapWrath = !!msg.awaitingSoulSwapWrath;
      state.armedAction = null;
      rerender();
      break;
    case 'error':
      state.error = msg.message;
      rerender();
      break;
    case 'connection-closed':
      state.error = 'Connection lost. Please refresh to reconnect.';
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
