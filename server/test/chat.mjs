import WebSocket from 'ws';

const a = new WebSocket('ws://localhost:3001');
const b = new WebSocket('ws://localhost:3001');
let code = null;
let received = false;

a.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    a.send(JSON.stringify({ type: 'create-room', roomType: '4p', name: 'Alice' }));
  } else if (msg.type === 'room-created') {
    code = msg.code;
    b.send(JSON.stringify({ type: 'join-room', code, name: 'Bob' }));
  }
});

b.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'room-joined') {
    a.send(JSON.stringify({ type: 'chat-message', text: 'hello from Alice' }));
  } else if (msg.type === 'chat-message') {
    received = true;
    const pass = msg.name === 'Alice' && msg.text === 'hello from Alice';
    console.log(pass ? 'PASS' : 'FAIL', msg);
    process.exit(pass ? 0 : 1);
  }
});

setTimeout(() => { console.log(received ? 'PASS (late)' : 'TIMEOUT - no chat message received'); process.exit(received ? 0 : 1); }, 5000);
