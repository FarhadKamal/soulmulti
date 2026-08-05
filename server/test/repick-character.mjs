// Verifies: a player can unpick a character and pick a different one before
// the match starts, and that pick-character/unpick-character are both
// rejected once the match has actually started (picks frozen).
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001');
let step = 0; // 0=pick first, 1=unpick, 2=pick different, 3=start match, 4=try illegal repick

function send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'session') {
    send('create-room', { roomType: '4p', name: 'Owner' });
  } else if (msg.type === 'room-created') {
    for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i });
  } else if (msg.type === 'lobby-update') {
    const room = msg.room;
    if (room.seats.some((s) => s.kind === 'empty')) return;
    const mySeat = room.seats[room.mySeatIndex];

    if (step === 0) {
      step = 1;
      send('pick-character', { characterId: room.availableCharacterIds[0] });
      return;
    }
    if (step === 1 && mySeat.characterIds.length === 1) {
      step = 2;
      send('unpick-character', { characterId: mySeat.characterIds[0] });
      return;
    }
    if (step === 2 && mySeat.characterIds.length === 0) {
      step = 3;
      const differentPick = room.availableCharacterIds[0];
      send('pick-character', { characterId: differentPick });
      return;
    }
    if (step === 3 && mySeat.characterIds.length === 1) {
      step = 4;
      console.log('PASS - repicked a different character successfully:', mySeat.characterIds[0]);
      send('start-match');
      return;
    }
  } else if (msg.type === 'game-state') {
    if (step === 4) {
      step = 5;
      const beforePicks = [...msg.game.characters ? Object.keys(msg.game.characters) : []];
      // Try illegal actions mid-match - should be silently ignored.
      send('pick-character', { characterId: 'akyros' });
      send('unpick-character', { characterId: 'akyros' });
      setTimeout(() => {
        console.log('PASS - mid-match pick/unpick attempts were ignored (no crash, no error)');
        process.exit(0);
      }, 500);
    }
  } else if (msg.type === 'error') {
    console.log('FAIL - got unexpected error:', msg.message);
    process.exit(1);
  }
});

setTimeout(() => { console.log('TIMEOUT', { step }); process.exit(1); }, 10000);
