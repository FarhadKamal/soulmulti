// Verifies game-state includes an accurate humanCount: 1 for a solo owner
// vs bots, 2 for two real players in the same match.
import WebSocket from 'ws';

async function runSolo() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3001');
    function send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }
    let myCharacterIds = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'session') send('create-room', { roomType: '4p', name: 'Solo' });
      else if (msg.type === 'room-created') { for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i }); }
      else if (msg.type === 'lobby-update') {
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
        ws.close();
        resolve(msg.humanCount);
      }
    });
    setTimeout(() => reject(new Error('solo timeout')), 8000);
  });
}

async function runDuo() {
  return new Promise((resolve, reject) => {
    const a = new WebSocket('ws://localhost:3001');
    const b = new WebSocket('ws://localhost:3001');
    function send(ws, type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }
    a.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'session') send(a, 'create-room', { roomType: '4p', name: 'A' });
      else if (msg.type === 'room-created') send(b, 'join-room', { code: msg.code, name: 'B' });
      else if (msg.type === 'lobby-update') {
        const room = msg.room;
        if (room.phase !== 'lobby') return;
        if (room.seats.some((s) => s.kind === 'empty' && s.index >= 2)) {
          send(a, 'fill-bot', { seatIndex: 2 });
          send(a, 'fill-bot', { seatIndex: 3 });
          return;
        }
        if (room.seats.some((s) => s.kind === 'empty')) return;
        const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
        if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
          send(a, 'pick-character', { characterId: room.availableCharacterIds[0] });
          return;
        }
        const bSeat = room.seats.find((s) => !s.isOwner && s.kind === 'human');
        if (bSeat && bSeat.characterIds.length < room.picksPerSeat) return;
        send(a, 'start-match');
      } else if (msg.type === 'game-state') {
        a.close(); b.close();
        resolve(msg.humanCount);
      }
    });
    b.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'lobby-update') {
        const room = msg.room;
        if (room.phase !== 'lobby') return;
        if (room.seats.some((s) => s.kind === 'empty')) return;
        const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;
        if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
          send(b, 'pick-character', { characterId: room.availableCharacterIds[0] });
        }
      }
    });
    setTimeout(() => reject(new Error('duo timeout')), 8000);
  });
}

(async () => {
  const solo = await runSolo();
  const duo = await runDuo();
  const pass = solo === 1 && duo === 2;
  console.log(pass ? 'PASS' : 'FAIL', { solo, duo });
  process.exit(pass ? 0 : 1);
})();
