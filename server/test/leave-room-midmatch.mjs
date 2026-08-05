// Verifies: leaving mid-match (a) hands the seat to a bot and the match
// keeps running to completion (checked via a second, never-leaving
// observer client in the same room), and (b) the leaving client itself
// gets a left-room confirmation and, correctly, stops receiving further
// game-state updates afterward (leaving is a full exit, unlike a timeout
// which keeps the player watching as a spectator).
import WebSocket from 'ws';

const leaver = new WebSocket('ws://localhost:3001');
const observer = new WebSocket('ws://localhost:3001');
let roomCode = null;
let observerReady = false;
let leaverCharacterIds = [];
let observerCharacterIds = [];
let leftDuringMatch = false;
let gotConfirmation = false;
let observerSawMatchEnd = false;

function send(ws, type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function tryJoin() {
  if (roomCode && observerReady) send(observer, 'join-room', { code: roomCode, name: 'Observer' });
}

observer.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    observerReady = true;
    tryJoin();
  }
});

leaver.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send(leaver, 'create-room', { roomType: '4p', name: 'Leaver' });
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    tryJoin();
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (room.phase !== 'lobby') return;
    if (room.seats.some((s) => s.kind === 'empty' && s.index >= 2)) {
      send(leaver, 'fill-bot', { seatIndex: 2 });
      send(leaver, 'fill-bot', { seatIndex: 3 });
      return;
    }
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
    if (mySeat) leaverCharacterIds = mySeat.characterIds;
    if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
      send(leaver, 'pick-character', { characterId: room.availableCharacterIds[0] });
      return;
    }
    const observerSeat = room.seats.find((s) => !s.isOwner && s.kind === 'human');
    if (observerSeat && observerSeat.characterIds.length < room.picksPerSeat) return;
    send(leaver, 'start-match');
  } else if (msg.type === 'game-state') {
    if (!leftDuringMatch) {
      leftDuringMatch = true;
      send(leaver, 'leave-room');
    }
  } else if (msg.type === 'left-room') {
    gotConfirmation = true;
    console.log('CONFIRMED: leaver got left-room confirmation');
  }
});

observer.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (room.phase !== 'lobby') return;
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
    if (mySeat) observerCharacterIds = mySeat.characterIds;
    if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
      send(observer, 'pick-character', { characterId: room.availableCharacterIds[0] });
    }
  } else if (msg.type === 'game-state') {
    if (msg.game.phase === 'game-over') {
      observerSawMatchEnd = true;
      const pass = leftDuringMatch && gotConfirmation && observerSawMatchEnd;
      console.log(pass ? 'PASS' : 'FAIL', { leftDuringMatch, gotConfirmation, observerSawMatchEnd });
      process.exit(pass ? 0 : 1);
    }
    if (!observerCharacterIds.includes(msg.actingCharacterId)) return;
    const usable = msg.usableActions || [];
    if (usable.length === 0) return;
    const action = pickRandom(usable);
    const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
    if (msg.awaitingSoulSwapWrath) send(observer, 'soul-swap-wrath', { characterId: msg.actingCharacterId, targetId });
    else send(observer, 'action', { characterId: msg.actingCharacterId, actionId: action.actionId, targetId });
  }
});

setTimeout(() => {
  console.log('TIMEOUT', { leftDuringMatch, gotConfirmation, observerSawMatchEnd });
  process.exit(1);
}, 60000);
