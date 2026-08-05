// Full 2p match with TWO real humans (2 bot-filled seats) both actively
// playing to completion - the path least exercised by other tests, which
// mostly use one human + bots. Both players act on their own turns; the
// test just watches for a clean game-over with no stalls/crashes.
import WebSocket from 'ws';

const p1 = new WebSocket('ws://localhost:3001');
const p2 = new WebSocket('ws://localhost:3001');
let roomCode = null;
let p2Ready = false;
let p1CharacterIds = [];
let p2CharacterIds = [];
let gameOverSeen = false;

function send(ws, type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function tryJoin() {
  if (roomCode && p2Ready) send(p2, 'join-room', { code: roomCode, name: 'P2' });
}

p2.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    p2Ready = true;
    tryJoin();
  }
});

function actIfMyTurn(ws, myCharacterIds, msg) {
  if (msg.game.phase === 'game-over') {
    if (!gameOverSeen) {
      gameOverSeen = true;
      console.log('PASS - two-human match completed. winner:', msg.game.winnerPlayerId, 'round:', msg.game.round, 'log entries:', msg.game.log.length);
      process.exit(0);
    }
    return;
  }
  const jb = msg.game.jesterBall;
  if (jb && jb.holderCharacterId && myCharacterIds.includes(jb.holderCharacterId)) {
    const choices = ['return_', 'take'];
    if (jb.canPass) choices.push('pass');
    const choice = pickRandom(choices);
    let targetId;
    if (choice === 'pass') {
      const candidates = Object.keys(msg.game.characters).filter((id) => id !== jb.holderCharacterId && !msg.game.characters[id].isKO);
      targetId = pickRandom(candidates);
    }
    send(ws, 'jester-ball-choice', { characterId: jb.holderCharacterId, choice, targetId });
    return;
  }
  if (!myCharacterIds.includes(msg.actingCharacterId)) return;
  const usable = msg.usableActions || [];
  if (usable.length === 0) return;
  const action = pickRandom(usable);
  const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
  if (msg.awaitingSoulSwapWrath) send(ws, 'soul-swap-wrath', { characterId: msg.actingCharacterId, targetId });
  else send(ws, 'action', { characterId: msg.actingCharacterId, actionId: action.actionId, targetId });
}

p1.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send(p1, 'create-room', { roomType: '2p', name: 'P1' });
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    tryJoin();
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (room.phase !== 'lobby') return;
    if (room.seats.some((s) => s.kind === 'empty' && s.index >= 2)) {
      send(p1, 'fill-bot', { seatIndex: 2 });
      send(p1, 'fill-bot', { seatIndex: 3 });
      return;
    }
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
    if (mySeat) p1CharacterIds = mySeat.characterIds;
    if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
      send(p1, 'pick-character', { characterId: room.availableCharacterIds[0] });
      return;
    }
    const p2Seat = room.seats.find((s) => !s.isOwner && s.kind === 'human');
    if (p2Seat && p2Seat.characterIds.length < room.picksPerSeat) return;
    send(p1, 'start-match');
  } else if (msg.type === 'game-state') {
    actIfMyTurn(p1, p1CharacterIds, msg);
  }
});

p2.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (room.phase !== 'lobby') return;
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
    if (mySeat) p2CharacterIds = mySeat.characterIds;
    if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
      send(p2, 'pick-character', { characterId: room.availableCharacterIds[0] });
    }
  } else if (msg.type === 'game-state') {
    actIfMyTurn(p2, p2CharacterIds, msg);
  }
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
