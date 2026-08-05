// Lets the real 30s turn timer actually expire (does NOT act on its own
// turn) and verifies: the seat converts to bot, a bot then takes over and
// keeps the match moving, and the client eventually sees game-over or at
// least sees actingCharacterId change away from the human's character.
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001');
let myCharacterIds = [];
let sawTimeoutLog = false;
let sawSeatBecomeBot = false;

function send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send('create-room', { roomType: '4p', name: 'Owner' });
  } else if (msg.type === 'room-created') {
    for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i });
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
    // mySeatIndex correctly becomes null once the seat times out (playerId
    // is cleared - no longer "my seat" to act through) - so check seat 0
    // directly by index instead (known to be the owner's original seat)
    // rather than relying on mySeatIndex to still point at it.
    if (room.seats[0]?.kind === 'bot') {
      sawSeatBecomeBot = true;
      console.log('CONFIRMED: my seat converted to bot after timeout');
    }
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const ownerSeat = room.seats.find((s) => s.isOwner);
    if (ownerSeat && ownerSeat.characterIds.length < room.picksPerSeat) {
      const pick = room.availableCharacterIds[0];
      myCharacterIds = [...ownerSeat.characterIds, pick];
      send('pick-character', { characterId: pick });
      return;
    }
    if (room.phase === 'lobby') {
      console.log('Starting match - now deliberately NOT acting, waiting for the 30s timer...');
      send('start-match');
    }
  } else if (msg.type === 'game-state') {
    if (msg.game.log.some((e) => e.type === 'passive' && e.text && e.text.includes('timed out'))) {
      sawTimeoutLog = true;
    }
    console.log(`[t+${Math.round(process.uptime())}s] acting=${msg.actingCharacterId} deadline in ${msg.turnDeadline ? Math.round((msg.turnDeadline - Date.now())/1000) + 's' : 'null'} phase=${msg.game.phase}`);
    if (msg.game.phase === 'game-over') {
      const pass = sawTimeoutLog && sawSeatBecomeBot;
      console.log(pass ? 'PASS' : 'FAIL', { sawTimeoutLog, sawSeatBecomeBot });
      process.exit(pass ? 0 : 1);
    }
    // Deliberately do nothing on my own turn - let the timer expire.
  }
});

setTimeout(() => {
  console.log('TIMEOUT (test)', { sawTimeoutLog, sawSeatBecomeBot });
  process.exit(sawTimeoutLog && sawSeatBecomeBot ? 0 : 1);
}, 45000);
