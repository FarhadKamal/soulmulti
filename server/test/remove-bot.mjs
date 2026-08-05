// Verifies: owner can fill a seat with a bot, then remove it back to
// empty, and a non-owner can't remove bots.
import WebSocket from 'ws';

const owner = new WebSocket('ws://localhost:3001');
const other = new WebSocket('ws://localhost:3001');
let roomCode = null;
let otherReady = false;
let step = 0;

function send(ws, type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }

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
    if (step === 0 && room.seats[1]?.kind === 'human') {
      step = 1;
      send(owner, 'fill-bot', { seatIndex: 2 });
    } else if (step === 1 && room.seats[2]?.kind === 'bot') {
      step = 2;
      // Non-owner tries to remove it - should be ignored.
      send(other, 'remove-bot', { seatIndex: 2 });
      setTimeout(() => {
        send(owner, 'remove-bot', { seatIndex: 2 });
      }, 300);
    } else if (step === 2 && room.seats[2]?.kind === 'empty') {
      console.log('PASS - owner removed the bot seat back to empty');
      process.exit(0);
    }
  }
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
