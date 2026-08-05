// Verifies: a solo owner (room full of bots, no other humans) can leave
// via leave-room, gets a left-room confirmation, and the room is deleted
// (a fresh join-room with the same code should fail as "not found").
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001');
let roomCode = null;
let gotLeftRoomConfirmation = false;

function send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send('create-room', { roomType: '4p', name: 'SoloOwner' });
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i });
  } else if (msg.type === 'lobby-update') {
    if (msg.room.seats.every((s) => s.kind !== 'empty') && !gotLeftRoomConfirmation) {
      send('leave-room');
    }
  } else if (msg.type === 'left-room') {
    gotLeftRoomConfirmation = true;
    console.log('CONFIRMED: got left-room confirmation');
    // Try to join the same room code - should fail since it was deleted
    // (no humans left after the solo owner exits a bots-only room).
    const second = new WebSocket('ws://localhost:3001');
    second.on('message', (raw2) => {
      const msg2 = JSON.parse(raw2.toString());
      if (msg2.type === 'session') {
        second.send(JSON.stringify({ type: 'join-room', code: roomCode, name: 'Late' }));
      } else if (msg2.type === 'error') {
        console.log('PASS - room correctly deleted:', msg2.message);
        process.exit(0);
      } else if (msg2.type === 'room-joined') {
        console.log('FAIL - room still existed after solo owner left');
        process.exit(1);
      }
    });
  }
});

setTimeout(() => { console.log('TIMEOUT', { gotLeftRoomConfirmation }); process.exit(1); }, 8000);
