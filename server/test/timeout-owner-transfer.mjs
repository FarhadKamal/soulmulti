// Verifies: when the ROOM OWNER'S turn times out, ownership transfers to
// the other human player, who can then successfully return-to-lobby, and
// the resulting lobby view correctly shows them as the new owner (isOwner
// label + youAreOwner flag both reflecting the transfer). The "other"
// player always acts immediately on their own turns (so only the owner,
// who deliberately never acts, can ever time out).
import WebSocket from 'ws';

const owner = new WebSocket('ws://localhost:3001');
const other = new WebSocket('ws://localhost:3001');
let roomCode = null;
let otherReady = false;
let ownerCharacterIds = [];
let otherCharacterIds = [];
let transferConfirmed = false;

function send(ws, type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function tryJoin() {
  if (roomCode && otherReady) send(other, 'join-room', { code: roomCode, name: 'Other' });
}

other.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    otherReady = true;
    tryJoin();
  }
});

owner.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send(owner, 'create-room', { roomType: '4p', name: 'Owner' });
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    tryJoin();
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (room.phase !== 'lobby') return;
    if (room.seats.some((s) => s.kind === 'empty' && s.index >= 2)) {
      send(owner, 'fill-bot', { seatIndex: 2 });
      send(owner, 'fill-bot', { seatIndex: 3 });
      return;
    }
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
    if (mySeat) ownerCharacterIds = mySeat.characterIds;
    if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
      send(owner, 'pick-character', { characterId: room.availableCharacterIds[0] });
      return;
    }
    const otherSeat = room.seats.find((s) => !s.isOwner && s.kind === 'human');
    if (otherSeat && otherSeat.characterIds.length < room.picksPerSeat) return;
    send(owner, 'start-match');
  }
  // No action ever taken on game-state - the owner deliberately stalls.
});

other.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (transferConfirmed) return;
    if (room.youAreOwner) {
      transferConfirmed = true;
      console.log('CONFIRMED: ownership transferred to the other player after timeout');
      return;
    }
    if (room.phase !== 'lobby') return;
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
    if (mySeat) otherCharacterIds = mySeat.characterIds;
    if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
      send(other, 'pick-character', { characterId: room.availableCharacterIds[0] });
    }
  } else if (msg.type === 'game-state') {
    if (msg.game.phase === 'game-over') {
      if (transferConfirmed) send(other, 'return-to-lobby');
      return;
    }
    if (!otherCharacterIds.includes(msg.actingCharacterId)) return;
    const usable = msg.usableActions || [];
    if (usable.length === 0) return;
    const action = pickRandom(usable);
    const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
    if (msg.awaitingSoulSwapWrath) send(other, 'soul-swap-wrath', { characterId: msg.actingCharacterId, targetId });
    else send(other, 'action', { characterId: msg.actingCharacterId, actionId: action.actionId, targetId });
  }
});

other.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'lobby-update' && transferConfirmed && msg.room.phase === 'lobby') {
    const mySeat = msg.room.seats.find((s) => s.isMe);
    const pass = msg.room.youAreOwner && mySeat && mySeat.isOwner;
    console.log(pass ? 'PASS' : 'FAIL', 'post-reset lobby view:', { youAreOwner: msg.room.youAreOwner, mySeat });
    process.exit(pass ? 0 : 1);
  }
});

setTimeout(() => { console.log('TIMEOUT', { transferConfirmed }); process.exit(1); }, 75000);
