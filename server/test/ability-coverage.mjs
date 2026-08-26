// Plays many matches (one human + bots, random legal choices each turn)
// and tracks which actionIds actually fired at least once across the whole
// run, to answer "did we actually exercise every character's every move"
// rather than just "did matches complete without crashing."
import WebSocket from 'ws';

const ALL_LABELS = {
  hiddenMark: 'Hidden Mark', fatalSlash: 'Fatal Slash', shadowExecution: 'Shadow Execution',
  curseStrike: 'Curse Strike', divineRestore: 'Divine Restore',
  bloodHunt: 'Blood Hunt',
  chaosGamble: 'Chaos Gamble', jesterBall: 'Jester Ball',
  cyclonePunch: 'Cyclone Punch', timeFreeze: 'Time Freeze',
  smash: 'Smash', titanToss: 'Titan Toss', titanSmash: 'Titan Smash', glorySmash: 'Glory Smash',
  lunarStrike: 'Lunar Strike', moonstep: 'Moonstep', lunarEclipse: 'Lunar Eclipse',
  chargeUp: 'Charge Up', thunderWrath: 'Thunder Wrath', soulSwap: 'Soul Swap', soulSwapWrath: 'Thunder Wrath (free)',
};
// 'return_' isn't a real choice anymore - it's what happens when a Pass
// happens to land on Boingo (see boingo.js's jesterBallResolution.pass) -
// kept as a coverage LABEL since the jester-ball-return log entry shape is
// unchanged, just reached differently now.
const JESTER_BALL_CHOICES = { return_: 'Jester Ball: Return (pass to Boingo)', take: 'Jester Ball: Take', pass: 'Jester Ball: Pass' };

const seen = new Set();
const MATCH_COUNT = process.argv[2] ? Number(process.argv[2]) : 60;
let completed = 0;

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function runOneMatch(roomType) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3001');
    let myCharacterIds = [];
    function send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'session') {
        send('create-room', { roomType, name: 'Owner' });
      } else if (msg.type === 'room-created') {
        for (let i = 1; i < 4; i++) send('fill-bot', { seatIndex: i });
      } else if (msg.type === 'lobby-update') {
        const room = msg.room;
        if (room.seats.some((s) => s.kind === 'empty')) return;
        const ownerSeat = room.seats.find((s) => s.isOwner);
        if (ownerSeat.characterIds.length < room.picksPerSeat) {
          const pick = pickRandom(room.availableCharacterIds);
          myCharacterIds = [...ownerSeat.characterIds, pick];
          send('pick-character', { characterId: pick });
          return;
        }
        if (room.phase === 'lobby') send('start-match');
      } else if (msg.type === 'game-state') {
        // Scan the FULL log (not just usableActions, which only covers the
        // human-controlled seat's own turns) so bot-driven actions for
        // every other character are counted too - this is the only way to
        // see what bots actually chose, since their turns resolve fully
        // server-side before any broadcast.
        for (const entry of msg.game.log) {
          if (entry.actionId && ALL_LABELS[entry.actionId]) seen.add(ALL_LABELS[entry.actionId]);
          if (entry.type === 'jester-ball-return') seen.add(JESTER_BALL_CHOICES.return_);
          if (entry.type === 'jester-ball-take') seen.add(JESTER_BALL_CHOICES.take);
          if (entry.type === 'jester-ball-pass') seen.add(JESTER_BALL_CHOICES.pass);
        }
        if (msg.game.phase === 'game-over') {
          ws.close();
          resolve();
          return;
        }
        if (!myCharacterIds.includes(msg.actingCharacterId)) return;
        const jb = msg.game.jesterBall;
        if (jb && jb.holderCharacterId === msg.actingCharacterId) {
          const choices = ['take'];
          if (jb.passCount < 5) choices.push('pass');
          const choice = pickRandom(choices);
          let targetId;
          if (choice === 'pass') {
            const candidates = Object.keys(msg.game.characters).filter((id) => id !== msg.actingCharacterId && !msg.game.characters[id].isKO);
            targetId = pickRandom(candidates);
          }
          send('jester-ball-choice', { characterId: msg.actingCharacterId, choice, targetId });
          return;
        }
        const usable = msg.usableActions || [];
        if (usable.length === 0) return;
        const action = pickRandom(usable);
        const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
        if (msg.awaitingSoulSwapWrath) send('soul-swap-wrath', { characterId: msg.actingCharacterId, targetId });
        else send('action', { characterId: msg.actingCharacterId, actionId: action.actionId, targetId });
      }
    });
    ws.on('error', () => resolve());
    setTimeout(resolve, 15000); // per-match safety timeout
  });
}

(async () => {
  for (let i = 0; i < MATCH_COUNT; i++) {
    await runOneMatch('4p');
    completed++;
  }
  const allLabels = new Set([...Object.values(ALL_LABELS), ...Object.values(JESTER_BALL_CHOICES)]);
  const missing = [...allLabels].filter((l) => !seen.has(l));
  console.log(`Completed ${completed}/${MATCH_COUNT} matches.`);
  console.log(`Actions seen (${seen.size}/${allLabels.size}):`, [...seen].sort());
  if (missing.length > 0) {
    console.log('NEVER SEEN:', missing);
  } else {
    console.log('PASS - every action fired at least once');
  }
  process.exit(missing.length > 0 ? 1 : 0);
})();
