// Verifies a chat message longer than 60 chars is truncated server-side.
import WebSocket from 'ws';

const owner = new WebSocket('ws://localhost:3001');
const other = new WebSocket('ws://localhost:3001');
let roomCode = null;
let otherReady = false;
const longText = 'x'.repeat(120);

function tryJoin() {
  if (roomCode && otherReady) {
    other.send(JSON.stringify({ type: 'join-room', code: roomCode, name: 'Other' }));
  }
}

owner.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    owner.send(JSON.stringify({ type: 'create-room', roomType: '4p', name: 'Owner' }));
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    tryJoin();
  }
});

other.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    otherReady = true;
    tryJoin();
  }
});

other.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'room-joined') {
    owner.send(JSON.stringify({ type: 'chat-message', text: longText }));
  } else if (msg.type === 'chat-message') {
    const pass = msg.text.length === 60 && msg.text === longText.slice(0, 60);
    console.log(pass ? 'PASS' : 'FAIL', 'truncated to', msg.text.length, 'chars');
    process.exit(pass ? 0 : 1);
  }
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);
