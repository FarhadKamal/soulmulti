// Live end-to-end smoke test of the full training4 flow against a running
// server: creates a training4 room, plays the human's own turns with
// random legal choices (mirroring ability-coverage.mjs's own random-play
// pattern), and watches real (non-scripted) bot combat unfold in between.
// Asserts the one behavioral invariant - the human's character never loses
// a heart (or gets KO'd) while more than 2 characters are alive - plus
// confirms the room does not auto-restart on game-over (unlike bots4).
import WebSocket from 'ws';

const HUMAN_CHARACTER_ID = 'tharox';
const TIMEOUT_MS = 120000;

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function livingCount(characters) { return Object.values(characters).filter((c) => !c.isKO).length; }

function playOne() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3001');
    let lastHumanHearts = null;
    let sawAbove2AliveWithHumanUnhurt = false;
    let sawHumanHitAt2Alive = false;
    let gameOverAt = null;
    let violation = null;
    let extraBroadcastAfterGameOver = false;

    const timeout = setTimeout(() => {
      clearTimeout(timeout);
      reject(new Error('TIMEOUT waiting for game-over'));
      ws.close();
    }, TIMEOUT_MS);

    function send(type, payload = {}) {
      ws.send(JSON.stringify({ type, ...payload }));
    }

    ws.on('error', (e) => { clearTimeout(timeout); reject(new Error(`ws error ${e.message}`)); });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`server error: ${msg.message}`));
        ws.close();
        return;
      }
      if (msg.type === 'session') {
        send('create-training-room', { name: 'TrainingTester', characterId: HUMAN_CHARACTER_ID });
        return;
      }
      if (msg.type !== 'game-state') return;

      const game = msg.game;
      const human = game.characters[HUMAN_CHARACTER_ID];
      if (!human) return;
      const alive = livingCount(game.characters);

      if (gameOverAt !== null) {
        // Any further game-state after we've already resolved the promise
        // (see the setTimeout below) would mean the room auto-restarted.
        extraBroadcastAfterGameOver = true;
        return;
      }

      if (lastHumanHearts !== null) {
        const humanWasHit = human.hearts < lastHumanHearts || (human.isKO && lastHumanHearts > 0);
        if (humanWasHit) {
          if (alive > 2) violation = `human was hit while ${alive} characters alive (hearts ${lastHumanHearts} -> ${human.hearts})`;
          else sawHumanHitAt2Alive = true;
        }
      }
      if (alive > 2 && human.hearts === lastHumanHearts) sawAbove2AliveWithHumanUnhurt = true;
      lastHumanHearts = human.hearts;

      if (game.phase === 'game-over') {
        gameOverAt = Date.now();
        clearTimeout(timeout);
        setTimeout(() => {
          resolve({ violation, sawAbove2AliveWithHumanUnhurt, sawHumanHitAt2Alive, extraBroadcastAfterGameOver });
          ws.close();
        }, 17000); // past BOT_SHOW_RESTART_DELAY_MS (12s, bots4-only)
        return;
      }

      // Play the human's own turn with a random legal choice, same pattern
      // as ability-coverage.mjs's own random-play loop.
      if (msg.actingCharacterId !== HUMAN_CHARACTER_ID) return;
      const jb = game.jesterBall;
      if (jb && jb.holderCharacterId === HUMAN_CHARACTER_ID) {
        const choices = ['take'];
        if (jb.passCount < 5) choices.push('pass');
        const choice = pickRandom(choices);
        let targetId;
        if (choice === 'pass') {
          const candidates = Object.keys(game.characters).filter((id) => id !== HUMAN_CHARACTER_ID && !game.characters[id].isKO);
          targetId = pickRandom(candidates);
        }
        send('jester-ball-choice', { characterId: HUMAN_CHARACTER_ID, choice, targetId });
        return;
      }
      const usable = msg.usableActions || [];
      if (usable.length === 0) return;
      const action = pickRandom(usable);
      const targetId = action.needsTarget ? pickRandom(action.validTargetIds) : null;
      if (msg.awaitingSoulSwapWrath) send('soul-swap-wrath', { characterId: HUMAN_CHARACTER_ID, targetId });
      else send('action', { characterId: HUMAN_CHARACTER_ID, actionId: action.actionId, targetId });
    });
  });
}

playOne()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    let failures = 0;
    if (result.violation) { console.error(`FAIL: ${result.violation}`); failures += 1; }
    else console.log('PASS: human never took damage while >2 characters alive');

    if (!result.sawAbove2AliveWithHumanUnhurt) { console.error('FAIL: never observed a >2-alive state (test too short to be meaningful)'); failures += 1; }
    else console.log('PASS: observed >2-alive combat state with human untouched');

    if (result.extraBroadcastAfterGameOver) { console.error('FAIL: room broadcast again after game-over (looks like an unwanted auto-restart)'); failures += 1; }
    else console.log('PASS: room did not auto-restart after game-over');

    if (!result.sawHumanHitAt2Alive) console.log("NOTE: human was never hit at 2-alive - not a failure (bot AI is non-deterministic; the important guarantee is it COULD happen, proven separately by training4-verify.mjs's direct isValidTarget check)");
    else console.log('PASS: human was hit once down to 2-alive (1v1), confirming the restriction lifted');

    console.log(failures > 0 ? `\n${failures} FAILURE(S)` : '\nAll training4-live checks passed.');
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
