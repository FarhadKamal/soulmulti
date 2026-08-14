// Direct-engine unit checks for training4's one behavioral rule: bots must
// never target the human's character while more than 2 characters are
// alive, but the restriction disappears entirely once it's down to a 1v1.
// Also proves zero behavior change to '4p'/'bots4' (negative control).
import { createGame } from '../engine/state.js';
import { isValidTarget, isValidMindControlTarget, isValidPuppetTarget } from '../engine/turnEngine.js';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures += 1;
  }
}

function makePicks() {
  return [
    { id: 'human-session', name: 'Human', characterIds: ['tharox'], isPC: false },
    { id: 'bot-1', name: 'Bot', characterIds: ['akyros'], isPC: true },
    { id: 'bot-2', name: 'Bot', characterIds: ['velorya'], isPC: true },
    { id: 'bot-3', name: 'Bot', characterIds: ['boingo'], isPC: true },
  ];
}

// --- 4 alive: bots must be blocked from targeting the human ---
{
  const game = createGame('training4', makePicks());
  assert(isValidTarget(game, 'akyros', 'lunarStrike', 'tharox') === false, '4-alive: akyros cannot target human (tharox)');
  assert(isValidTarget(game, 'velorya', 'lunarStrike', 'tharox') === false, '4-alive: velorya cannot target human (tharox)');
  assert(isValidTarget(game, 'boingo', 'chaosGamble', 'tharox') === false, '4-alive: boingo cannot target human (tharox)');
  assert(isValidTarget(game, 'akyros', 'thunderWrath', 'velorya') === true, '4-alive: bot can still target another bot');
}

// --- KO 2 bots, down to exactly 2 alive: restriction lifts entirely ---
{
  const game = createGame('training4', makePicks());
  game.characters.velorya.isKO = true;
  game.characters.boingo.isKO = true;
  assert(isValidTarget(game, 'akyros', 'thunderWrath', 'tharox') === true, '2-alive: last bot CAN now target human');
}

// --- Melyssa puppet-selection carve-out ---
{
  const picks = [
    { id: 'human-session', name: 'Human', characterIds: ['tharox'], isPC: false },
    { id: 'bot-1', name: 'Bot', characterIds: ['melyssa'], isPC: true },
    { id: 'bot-2', name: 'Bot', characterIds: ['velorya'], isPC: true },
    { id: 'bot-3', name: 'Bot', characterIds: ['boingo'], isPC: true },
  ];
  const game = createGame('training4', picks);
  assert(isValidMindControlTarget(game, 'tharox') === false, '4-alive: bot Melyssa cannot select human as puppet');
  assert(isValidMindControlTarget(game, 'velorya') === true, '4-alive: bot Melyssa can still select a bot ally as puppet');
  assert(isValidPuppetTarget(game, 'velorya', 'lunarStrike', 'tharox') === false, '4-alive: puppeted bot cannot real-target human');

  game.characters.velorya.isKO = true;
  game.characters.boingo.isKO = true;
  assert(isValidMindControlTarget(game, 'tharox') === true, '2-alive: bot Melyssa CAN now select human as puppet');
}

// --- Negative control: identical scenario under '4p'/'bots4' must be unaffected ---
{
  const game4p = createGame('4p', makePicks());
  assert(isValidTarget(game4p, 'akyros', 'lunarStrike', 'tharox') === true, "4p: no training4 restriction applies");
  const gameBots4 = createGame('bots4', makePicks());
  assert(isValidTarget(gameBots4, 'akyros', 'lunarStrike', 'tharox') === true, "bots4: no training4 restriction applies");
}

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll training4-verify checks passed.');
