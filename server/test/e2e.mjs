// End-to-end smoke test: connects as the room owner, bot-fills the other
// seat(s), picks character(s) for itself, starts the match, then plays its
// own turns by picking randomly from the server's OWN usableActions/
// validTargetIds summary - exactly what a real client does (see
// battleScreen.js) - rather than calling engine bot-decision functions
// directly against the sanitized wire format. (An earlier version of this
// test called chooseBotMove()/chooseSoulSwapWrathTarget() on the
// JSON-broadcast game snapshot directly, which crashes for Akyros since
// those functions expect real Set objects for special.marks etc., and the
// broadcast format intentionally strips/flattens that - see
// sanitizeGameForBroadcast in index.js. That was a test bug, not a server
// bug: a real client never touches engine internals, it only ever acts on
// the usableActions summary, so the test should too.)
import WebSocket from 'ws';

const roomType = '4p';
const ws = new WebSocket('ws://localhost:3001');
let myCharacterIds = [];
let gameOverSeen = false;

function send(type, payload = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

ws.on('open', () => console.log('connected, roomType=', roomType));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'session') {
    send('create-room', { roomType, name: 'Owner' });
  } else if (msg.type === 'room-created') {
    console.log('room created:', msg.code);
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
    if (room.phase === 'lobby') {
      console.log('starting match, seats:', room.seats.map((s) => `${s.kind}:${s.characterIds.join('+')}`));
      send('start-match');
    }
  } else if (msg.type === 'game-state') {
    if (msg.game.phase === 'game-over') {
      if (!gameOverSeen) {
        gameOverSeen = true;
        console.log('GAME OVER. winner:', msg.game.winnerPlayerId, 'round:', msg.game.round, 'log entries:', msg.game.log.length);
        process.exit(0);
      }
      return;
    }
    if (!myCharacterIds.includes(msg.actingCharacterId)) return; // a bot seat's turn - server handles it
    const myCharacterId = msg.actingCharacterId;

    const jb = msg.game.jesterBall;
    if (jb && jb.holderCharacterId === myCharacterId) {
      // Same random choice a client would offer: take, or pass (to a
      // random living non-self character - can include Boingo, which
      // heals him and ends the ball, same as the old dedicated 'return_'
      // choice) if passing is still available (passCount < 5, not the old
      // one-shot canPass flag).
      const choices = ['take'];
      if (jb.passCount < 5) choices.push('pass');
      const choice = pickRandom(choices);
      let targetId;
      if (choice === 'pass') {
        const candidates = Object.keys(msg.game.characters).filter((id) => id !== myCharacterId && !msg.game.characters[id].isKO);
        targetId = pickRandom(candidates);
      }
      send('jester-ball-choice', { characterId: myCharacterId, choice, targetId });
      return;
    }

    const usable = msg.usableActions || [];
    if (usable.length === 0) return; // nothing to do (shouldn't normally happen while acting)
    const action = pickRandom(usable);
    const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
    if (msg.awaitingSoulSwapWrath) {
      send('soul-swap-wrath', { characterId: myCharacterId, targetId });
    } else {
      send('action', { characterId: myCharacterId, actionId: action.actionId, targetId });
    }
  } else if (msg.type === 'error') {
    console.log('ERROR:', msg.message);
  }
});

setTimeout(() => {
  console.log('TIMEOUT - match never finished');
  process.exit(1);
}, 60000);
