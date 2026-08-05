// Verifies each client's lobby-update payload is correctly personalized:
// the owner sees youAreOwner=true and their own seat's isMe=true; a joiner
// sees youAreOwner=false and a DIFFERENT seat marked isMe=true - and the
// two clients never see the same seat marked isMe.
import WebSocket from 'ws';

const owner = new WebSocket('ws://localhost:3001');
const joiner = new WebSocket('ws://localhost:3001');
let roomCode = null;
let joinerReady = false;
let ownerView = null;
let joinerView = null;

function tryJoin() {
  if (roomCode && joinerReady) joiner.send(JSON.stringify({ type: 'join-room', code: roomCode, name: 'Joiner' }));
}

function checkDone() {
  if (!ownerView || !joinerView) return;
  const ownerMySeat = ownerView.seats.find((s) => s.isMe);
  const joinerMySeat = joinerView.seats.find((s) => s.isMe);
  const pass = ownerView.youAreOwner === true
    && joinerView.youAreOwner === false
    && ownerMySeat && joinerMySeat
    && ownerMySeat.index !== joinerMySeat.index
    && ownerView.mySeatIndex === ownerMySeat.index
    && joinerView.mySeatIndex === joinerMySeat.index;
  console.log(pass ? 'PASS' : 'FAIL', {
    ownerYouAreOwner: ownerView.youAreOwner,
    joinerYouAreOwner: joinerView.youAreOwner,
    ownerMySeatIndex: ownerView.mySeatIndex,
    joinerMySeatIndex: joinerView.mySeatIndex,
  });
  process.exit(pass ? 0 : 1);
}

owner.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    owner.send(JSON.stringify({ type: 'create-room', roomType: '4p', name: 'Owner' }));
  } else if (msg.type === 'room-created') {
    roomCode = msg.code;
    tryJoin();
  } else if (msg.type === 'lobby-update') {
    ownerView = msg.room;
    checkDone();
  }
});

joiner.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    joinerReady = true;
    tryJoin();
  } else if (msg.type === 'lobby-update') {
    joinerView = msg.room;
    checkDone();
  }
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
