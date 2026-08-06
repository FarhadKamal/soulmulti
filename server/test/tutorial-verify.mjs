// Plays every one of the 8 tutorial sequences end-to-end via the real
// WebSocket protocol, exactly as a client would (follows
// tutorialRequiredActionId/TargetId, never touches server internals),
// and reports the final result (winner, human hearts, damage sum) for
// comparison against the plan's summary table.
import WebSocket from 'ws';

const CHARACTERS = ['chronox', 'tharox', 'zerathys', 'akyros', 'velorya', 'boingo', 'blade', 'athena'];
const EXPECTED = {
  chronox: { humanTurns: 5, finalHearts: 5 },
  tharox: { humanTurns: 5, finalHearts: 5 },
  zerathys: { humanTurns: 6, finalHearts: 4 },
  akyros: { humanTurns: 4, finalHearts: 5 },
  velorya: { humanTurns: 7, finalHearts: 1 },
  boingo: { humanTurns: 2, finalHearts: 6 },
  blade: { humanTurns: 4, finalHearts: 4 },
  athena: { humanTurns: 8, finalHearts: 3 },
};

function playOne(characterId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3001');
    let humanCharacterId = null;
    let humanTurnsTaken = 0;
    let gameOverSeen = false;
    const timeout = setTimeout(() => {
      reject(new Error(`${characterId}: TIMEOUT waiting for game-over`));
      ws.close();
    }, 30000);

    function send(type, payload = {}) {
      ws.send(JSON.stringify({ type, ...payload }));
    }

    ws.on('open', () => {});
    ws.on('error', (e) => { clearTimeout(timeout); reject(new Error(`${characterId}: ws error ${e.message}`)); });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`${characterId}: server error: ${msg.message}`));
        ws.close();
        return;
      }
      if (msg.type === 'session') {
        send('create-tutorial-room', { name: `Tester-${characterId}`, characterId });
      } else if (msg.type === 'room-created') {
        // wait for the first game-state broadcast
      } else if (msg.type === 'game-state') {
        if (msg.game.phase === 'game-over') {
          if (gameOverSeen) return;
          gameOverSeen = true;
          clearTimeout(timeout);
          const human = msg.game.characters[humanCharacterId];
          resolve({
            characterId,
            winnerIsHuman: !!msg.game.winnerPlayerId,
            draw: !msg.game.winnerPlayerId,
            humanFinalHearts: human ? human.hearts : null,
            humanKO: human ? human.isKO : null,
            humanTurnsTaken,
            logLength: msg.game.log.length,
          });
          ws.close();
          return;
        }
        if (!humanCharacterId) {
          // First broadcast: figure out which character is ours by checking
          // which one the tutorialRequiredActionId applies to (the acting
          // character on this very first human-first-turn broadcast).
          if (msg.actingCharacterId && msg.tutorialRequiredActionId) {
            humanCharacterId = msg.actingCharacterId;
          }
        }
        if (msg.actingCharacterId !== humanCharacterId) return; // bot's turn, server handles it
        if (!msg.tutorialRequiredActionId) return; // shouldn't happen but guard anyway
        const requiredActionId = msg.tutorialRequiredActionId;
        const requiredTargetId = msg.tutorialRequiredTargetId;
        humanTurnsTaken += 1;
        if (msg.awaitingSoulSwapWrath) {
          send('soul-swap-wrath', { characterId: humanCharacterId, targetId: requiredTargetId });
        } else {
          send('action', { characterId: humanCharacterId, actionId: requiredActionId, targetId: requiredTargetId });
        }
      }
    });
  });
}

async function main() {
  const results = [];
  for (const characterId of CHARACTERS) {
    try {
      const result = await playOne(characterId);
      results.push(result);
      const expected = EXPECTED[characterId];
      const pass = result.winnerIsHuman && !result.draw && result.humanFinalHearts === expected.finalHearts;
      console.log(
        `${pass ? 'PASS' : 'FAIL'} ${characterId}: winnerIsHuman=${result.winnerIsHuman} draw=${result.draw} ` +
        `finalHearts=${result.humanFinalHearts} (expected ${expected.finalHearts}) humanKO=${result.humanKO} logLen=${result.logLength}`
      );
    } catch (e) {
      console.log(`FAIL ${characterId}: ${e.message}`);
    }
  }
  const failed = results.length < CHARACTERS.length;
  process.exit(failed ? 1 : 0);
}

main();

// Debug: run once for chronox alone and print full log
