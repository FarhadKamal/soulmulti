import { applyDamage, applyHeal, applyShield, decayShieldIfDue } from '../engine/damagePipeline.js';
import { rollChaosGamble } from '../engine/random.js';

// Shield decays at the start of his own next turn, same mechanic/pattern
// as Tharox's Glory Smash and Athena's old Divine Restore shield - added
// as part of the "win" outcome below (see chaosGamble's execute) so a
// good roll leaves him with a little protection until his next turn,
// rather than pure damage with no lasting benefit. Doesn't stack across
// wins in practice: he only gets one Chaos Gamble roll per turn, and any
// prior shield already decays before his own next turn's roll runs.
export function onTurnStart(character, game, log) {
  decayShieldIfDue(character);
}

export const actions = {
  chaosGamble: {
    label: 'Chaos Gamble',
    needsTarget: true,
    isLegal: () => true,
    // Pure probability roll, same as cyclonePunch's flipCoin - rolled here
    // server-side rather than accepted as a client-supplied outcome (a
    // client "reporting" its own roll would be an exploit vector, and the
    // server is the sole authority on random outcomes). Previously this
    // expected an `outcome` argument nobody ever passed - executeAction()
    // is always called with 4 args from index.js (both the human action
    // handler and the paced bot-turn stepper), so outcome was always
    // undefined, amount was always 0, and Chaos Gamble silently always
    // missed for everyone, human or bot.
    execute(character, targetId, game, log) {
      const outcome = rollChaosGamble();
      let amount = 0;
      if (outcome === 'win') amount = 3;
      else if (outcome === 'draw') amount = 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      // A "win" roll also grants +1 decaying shield - some small lasting
      // benefit from a good roll instead of pure damage-and-done, expires
      // at the start of his own next turn same as Tharox's shield.
      if (outcome === 'win') applyShield(game, character.id, 1, { decaying: true });
      log.push({ type: 'attack', characterId: character.id, actionId: 'chaosGamble', targetId, outcome, ...result });
      return result;
    },
  },
  jesterBall: {
    label: 'Jester Ball',
    needsTarget: true,
    special: true,
    // 2 total throws per match (buffed from 1 - see state.js's
    // jesterBallsUsed comment) - ALSO requires no ball currently in play
    // (game.jesterBall must be null). Confirmed live bug: the original
    // 1-throw version never needed this check explicitly, since
    // !character.usedSpecial already went false after the single throw
    // regardless of whether a ball was active - but with 2 throws, nothing
    // stopped Boingo from throwing a SECOND ball while the first was still
    // live (only the current HOLDER is forced to resolve before acting;
    // Boingo himself, once it's genuinely his own turn again, was never
    // blocked from throwing again). A second throw would have silently
    // overwritten game.jesterBall, losing track of the first ball's
    // holder/passCount entirely.
    isLegal: (character, game) => character.special.jesterBallsUsed < 2 && !game.jesterBall,
    execute(character, targetId, game, log) {
      character.special.jesterBallsUsed += 1;
      // Only flips the shared usedSpecial flag once BOTH throws are spent -
      // that flag is read generically elsewhere as "has this character's
      // signature move been used at all" (see state.js's comment on
      // jesterBallsUsed for the exact call sites) and none of them are
      // Boingo-aware, so setting it early after just the FIRST throw would
      // make those generic checks wrongly report him as fully spent while
      // he still has a second ball banked.
      if (character.special.jesterBallsUsed >= 2) character.usedSpecial = true;
      // passCount tracks how many times it's been PASSED since the throw
      // (the throw itself doesn't count) - up to 5 passes are allowed
      // before an un-intercepted pass auto-resolves as an explosion (see
      // jesterBallResolution.pass below). Replaces the old one-shot
      // canPass flag now that passing is repeatable.
      game.jesterBall = {
        thrownByCharacterId: character.id,
        holderCharacterId: targetId,
        passCount: 0,
      };
      log.push({ type: 'special', characterId: character.id, actionId: 'jesterBall', targetId });
      return {};
    },
  },
};

// Shared by both a voluntary Take and an un-intercepted 5th pass (see
// jesterBallResolution.pass below) - same flat-4 damage, same Rebirth
// interception, same log entry shape, same jesterBall teardown, regardless
// of which path triggered it.
function resolveExplosion(game, log, holderId) {
  const result = applyDamage(game, log, {
    sourceCharacterId: game.jesterBall.thrownByCharacterId,
    targetCharacterId: holderId,
    amount: 4,
  });
  log.push({ type: 'jester-ball-take', targetCharacterId: holderId, ...result });
  game.jesterBall = null;
  return result;
}

// Resolved on the holder's own turn, not via the normal action list.
export const jesterBallResolution = {
  pass: {
    label: 'Pass to another player',
    isLegal: (game) => game.jesterBall.passCount < 5,
    execute(game, log, newHolderCharacterId) {
      const fromCharacterId = game.jesterBall.holderCharacterId;
      game.jesterBall.passCount += 1;
      // Landing on Boingo (the original thrower) always heals him and ends
      // the ball immediately, regardless of which pass number this was -
      // same outcome the old dedicated "Return to Boingo" choice produced,
      // now reached by passing TO him rather than a separate button.
      if (newHolderCharacterId === game.jesterBall.thrownByCharacterId) {
        // applyHeal no-ops (returns 0) if Boingo is already KO'd or already
        // at full hearts - report what actually happened (and why) rather
        // than always claiming the full +4, which would be misleading.
        const wasKO = game.characters[newHolderCharacterId]?.isKO ?? false;
        const healed = applyHeal(game, newHolderCharacterId, 4);
        log.push({ type: 'jester-ball-return', boingoId: newHolderCharacterId, healed, wasKO });
        game.jesterBall = null;
        return;
      }
      // Illyra's passive: a 50% chance a pass TO her simply fails - the
      // ball phases through her illusion and detonates on whoever tried to
      // pass it instead, as if it fumbled in their own hands (confirmed
      // ruling: identical resolveExplosion rules as any other explosion -
      // flat 4 damage, Rebirth-interceptable - just landing on the PASSER
      // rather than her). She never becomes the holder at all in this
      // case - game.jesterBall.holderCharacterId is never updated to her,
      // so no jester-ball-pass log entry is pushed either (the pass never
      // truly completed). passCount still increments above regardless of
      // outcome, same as any other pass attempt.
      if (newHolderCharacterId === 'illyra' && Math.random() < 0.5) {
        log.push({ type: 'dodge', attackerId: fromCharacterId, targetCharacterId: 'illyra' });
        // Confirmed ruling: this must NEVER be Boingo himself - a failed
        // pass FROM Boingo TO Illyra should never explode 4 damage onto
        // Boingo, since landing on him is always meant to heal, not hurt,
        // him (the whole point of the return-to-Boingo branch just above).
        // Boingo can never actually be fromCharacterId here in practice
        // anyway (he'd need to be holding the ball and choosing to pass it
        // to Illyra himself, at which point he'd already be excluded by
        // the newHolderCharacterId === thrownByCharacterId branch above if
        // HE were the new holder - but fromCharacterId being Boingo, while
        // passing to someone else entirely, is a completely normal,
        // reachable case) - guarded explicitly regardless, since silently
        // exploding on him would be a real, damaging bug if this
        // assumption is ever wrong.
        if (fromCharacterId === game.jesterBall.thrownByCharacterId) {
          const wasKO = game.characters[fromCharacterId]?.isKO ?? false;
          const healed = applyHeal(game, fromCharacterId, 4);
          log.push({ type: 'jester-ball-return', boingoId: fromCharacterId, healed, wasKO });
          game.jesterBall = null;
          return;
        }
        resolveExplosion(game, log, fromCharacterId);
        return;
      }
      game.jesterBall.holderCharacterId = newHolderCharacterId;
      // The 5th pass that DOESN'T land on Boingo auto-resolves as an
      // explosion on whoever just received it - no 6th holder ever gets a
      // choice. Reuses the exact same resolution as a voluntary Take.
      if (game.jesterBall.passCount === 5) {
        resolveExplosion(game, log, newHolderCharacterId);
        return;
      }
      log.push({ type: 'jester-ball-pass', fromCharacterId, toCharacterId: newHolderCharacterId });
    },
  },
  take: {
    label: 'Take it',
    execute(game, log) {
      return resolveExplosion(game, log, game.jesterBall.holderCharacterId);
    },
  },
};
