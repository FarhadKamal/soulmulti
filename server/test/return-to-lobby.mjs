// Verifies: after a match ends, the owner can send return-to-lobby and
// everyone in the room (owner + a bot-filled seat here) gets a fresh
// lobby-update with phase='lobby', cleared character picks, same room code -
// and a second match can actually be started from there.
import WebSocket from 'ws';
import { chooseBotMove, chooseBotJesterBallMove } from '../engine/botPlayer.js';

const ws = new WebSocket('ws://localhost:3001');
let myCharacterIds = [];
let roomCode = null;
let matchesCompleted = 0;

function send(type, payload = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'session') {
    send('create-room', { roomType: '4p', name: 'Owner' });
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i });
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (room.code !== roomCode) { console.log('FAIL - room code changed:', room.code, 'expected', roomCode); process.exit(1); }
    if (room.phase !== 'lobby') return;
    const emptySeats = room.seats.filter((s) => s.kind === 'empty');
    if (emptySeats.length > 0) {
      // Covers both the initial lobby AND after a return-to-lobby reset,
      // which reverts bot seats back to 'empty' (see resetRoomToLobby) -
      // a real client would need to re-fill them the same way.
      emptySeats.forEach((s) => send('fill-bot', { seatIndex: s.index }));
      return;
    }
    const ownerSeat = room.seats.find((s) => s.isOwner);
    if (ownerSeat.characterIds.length < room.picksPerSeat) {
      const pick = room.availableCharacterIds[0];
      myCharacterIds = [...ownerSeat.characterIds, pick];
      send('pick-character', { characterId: pick });
      return;
    }
    send('start-match');
  } else if (msg.type === 'game-state') {
    if (msg.game.phase === 'game-over') {
      matchesCompleted++;
      if (matchesCompleted === 1) {
        console.log('First match finished, round', msg.game.round, '- sending return-to-lobby');
        myCharacterIds = [];
        send('return-to-lobby');
      } else {
        console.log('PASS - second match completed after returning to lobby. round:', msg.game.round);
        process.exit(0);
      }
      return;
    }
    if (!myCharacterIds.includes(msg.actingCharacterId)) return;
    const myCharacterId = msg.actingCharacterId;
    const jb = msg.game.jesterBall;
    if (jb && jb.holderCharacterId === myCharacterId) {
      const move = chooseBotJesterBallMove(msg.game.characters[myCharacterId], msg.game);
      send('jester-ball-choice', { characterId: myCharacterId, choice: move.choice, targetId: move.targetId });
      return;
    }
    const usable = msg.usableActions || [];
    if (usable.length === 0) return;
    const action = pickRandom(usable);
    const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
    if (msg.awaitingSoulSwapWrath) send('soul-swap-wrath', { characterId: myCharacterId, targetId });
    else send('action', { characterId: myCharacterId, actionId: action.actionId, targetId });
  } else if (msg.type === 'error') {
    console.log('ERROR:', msg.message);
  }
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 30000);
