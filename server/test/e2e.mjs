// End-to-end smoke test: connects as the room owner, bot-fills the other
// seat(s), picks character(s) for itself, starts the match, then plays its
// own turns using the same bot decision logic as a stand-in (so the whole
// match auto-completes without a real human) - just to prove the full
// create->join->pick->start->play->game-over pipeline works over real
// WebSocket messages end to end.
//
// Usage: node test/e2e.mjs [4p|2p]
import WebSocket from 'ws';
import { chooseBotMove, chooseBotJesterBallMove, chooseSoulSwapWrathTarget } from '../engine/botPlayer.js';

const roomType = process.argv[2] === '2p' ? '2p' : '4p';
const ws = new WebSocket('ws://localhost:3001');
let myCharacterIds = [];
let gameOverSeen = false;

function send(type, payload = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}

ws.on('open', () => console.log('connected, roomType=', roomType));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'session') {
    send('create-room', { roomType, name: 'Owner' });
  } else if (msg.type === 'room-created') {
    console.log('room created:', msg.code);
    for (let i = 1; i < (roomType === '2p' ? 2 : 4); i++) send('fill-bot', { seatIndex: i });
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
    if (msg.awaitingSoulSwapWrath) {
      const character = msg.game.characters[myCharacterId];
      const target = chooseSoulSwapWrathTarget(character, msg.game) || Object.keys(msg.game.characters).find((id) => id !== myCharacterId && !msg.game.characters[id].isKO);
      send('soul-swap-wrath', { characterId: myCharacterId, targetId: target });
      return;
    }
    const jb = msg.game.jesterBall;
    const character = msg.game.characters[myCharacterId];
    if (jb && jb.holderCharacterId === myCharacterId) {
      const move = chooseBotJesterBallMove(character, msg.game);
      send('jester-ball-choice', { characterId: myCharacterId, choice: move.choice, targetId: move.targetId });
      return;
    }
    const move = chooseBotMove(character, msg.game);
    if (move) {
      send('action', { characterId: myCharacterId, actionId: move.actionId, targetId: move.targetId });
    }
  } else if (msg.type === 'error') {
    console.log('ERROR:', msg.message);
  }
});

setTimeout(() => {
  console.log('TIMEOUT - match never finished');
  process.exit(1);
}, 20000);
