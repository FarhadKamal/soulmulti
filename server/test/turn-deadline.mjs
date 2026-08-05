// Verifies game-state broadcasts include a sane turnDeadline (a timestamp
// roughly 30s in the future) while a decision is pending, and null once the
// match ends.
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001');
let myCharacterIds = [];
let checkedFirstDeadline = false;

function send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send('create-room', { roomType: '4p', name: 'Owner' });
  } else if (msg.type === 'room-created') {
    for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i });
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
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
    if (msg.game.phase === 'game-over') {
      const pass = msg.turnDeadline === null;
      console.log(pass ? 'PASS' : 'FAIL', 'turnDeadline at game-over:', msg.turnDeadline);
      process.exit(pass ? 0 : 1);
    }
    if (!checkedFirstDeadline && myCharacterIds.includes(msg.actingCharacterId)) {
      checkedFirstDeadline = true;
      const now = Date.now();
      const delta = msg.turnDeadline - now;
      // Small upper-bound slack (30500 not 30000) - the deadline is set
      // server-side slightly before this client-side Date.now() check runs,
      // so a few ms of clock/scheduling jitter is expected, not a bug.
      const pass = msg.turnDeadline && delta > 25000 && delta <= 30500;
      console.log(pass ? 'PASS' : 'FAIL', 'turnDeadline ~30s out:', { turnDeadline: msg.turnDeadline, deltaMs: delta });
      if (!pass) process.exit(1);
    }
    if (!myCharacterIds.includes(msg.actingCharacterId)) return;
    const usable = msg.usableActions || [];
    if (usable.length === 0) return;
    const action = pickRandom(usable);
    const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
    if (msg.awaitingSoulSwapWrath) send('soul-swap-wrath', { characterId: msg.actingCharacterId, targetId });
    else send('action', { characterId: msg.actingCharacterId, actionId: action.actionId, targetId });
  }
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 20000);
