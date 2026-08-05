import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001');
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    ws.send(JSON.stringify({ type: 'create-room', roomType: '4p', name: '   ' }));
  } else if (msg.type === 'error') {
    console.log('PASS - rejected empty name:', msg.message);
    process.exit(0);
  } else if (msg.type === 'room-created') {
    console.log('FAIL - empty name was accepted');
    process.exit(1);
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);
