// Verifies: the owner can abandon an in-progress match (solo vs bots),
// getting reset to a fresh lobby in the SAME room (same code, cleared
// picks) rather than being removed from the room - distinct from
// return-to-lobby (only valid after game-over) and leave-room (removes you
// from the room entirely).
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001');
let myCharacterIds = [];
let roomCode = null;
let abandoned = false;

function send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send('create-room', { roomType: '4p', name: 'Owner' });
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i });
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (abandoned) {
      const pass = room.code === roomCode && room.phase === 'lobby'
        && room.seats.every((s) => s.characterIds.length === 0);
      console.log(pass ? 'PASS' : 'FAIL', 'reset to same room lobby:', { code: room.code, phase: room.phase, seats: room.seats.map((s) => s.characterIds) });
      process.exit(pass ? 0 : 1);
    }
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const ownerSeat = room.seats.find((s) => s.isOwner);
    if (ownerSeat.characterIds.length < room.picksPerSeat) {
      const pick = room.availableCharacterIds[0];
      myCharacterIds = [...ownerSeat.characterIds, pick];
      send('pick-character', { characterId: pick });
      return;
    }
    if (room.phase === 'lobby') send('start-match');
  } else if (msg.type === 'game-state') {
    if (!abandoned) {
      abandoned = true;
      send('abandon-match');
    }
  }
});

setTimeout(() => { console.log('TIMEOUT', { abandoned }); process.exit(1); }, 15000);
