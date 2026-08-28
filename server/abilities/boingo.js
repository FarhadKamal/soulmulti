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
    // Back to 1 throw per match (reverted from the earlier 2-throw buff -
    // confirmed ruling, alongside the pass-cap/Boingo-toll-booth rework
    // below) - ALSO requires no ball currently in play (game.jesterBall
    // must be null), though with only 1 throw ever available that check is
    // now mostly defensive rather than load-bearing.
    isLegal: (character, game) => character.special.jesterBallsUsed < 1 && !game.jesterBall,
    execute(character, targetId, game, log) {
      character.special.jesterBallsUsed += 1;
      if (character.special.jesterBallsUsed >= 1) character.usedSpecial = true;
      // passCount tracks how many times it's been PASSED since the throw
      // (the throw itself doesn't count) - up to 10 passes are allowed
      // (raised from 5, confirmed ruling) before an un-intercepted pass
      // auto-resolves as an explosion (see jesterBallResolution.pass
      // below). Boingo landing on it mid-sequence no longer auto-ends the
      // whole thing (see jesterBallResolution.pass's own comment) - he
      // just becomes a real holder like anyone else, so passCount can now
      // legitimately climb past what a single throw+chain used to reach in
      // practice.
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
    // Confirmed ruling: cannot be dodged/evaded in any way (Akyros, Marin's
    // Threefold Veil, Grimtal, Illyra's passive) and bypasses untargetable
    // (e.g. Velorya mid-Lunar Eclipse) too - the explosion is going off in
    // the holder's own hands, not a fresh attack being aimed at them that
    // evasion could plausibly avoid. Same reasoning/precedent as Illyra's
    // Mirage Burst and Tharox's Earthshatter.
    ignoresDodge: true,
    ignoresUntargetable: true,
  });
  log.push({ type: 'jester-ball-take', targetCharacterId: holderId, ...result });
  game.jesterBall = null;
  return result;
}

// Total passes allowed before an un-intercepted pass auto-resolves as an
// explosion on whoever just received it (raised from 5, confirmed ruling,
// alongside the Boingo-toll-booth rework below - a longer chain means more
// opportunities for it to route back through Boingo for his +1 checkpoint
// heals before the final outcome is decided).
const MAX_JESTER_BALL_PASSES = 10;

// Resolved on the holder's own turn, not via the normal action list.
export const jesterBallResolution = {
  pass: {
    label: 'Pass to another player',
    isLegal: (game) => game.jesterBall.passCount < MAX_JESTER_BALL_PASSES,
    execute(game, log, newHolderCharacterId) {
      const fromCharacterId = game.jesterBall.holderCharacterId;
      game.jesterBall.passCount += 1;
      // Landing on Boingo (the original thrower) mid-sequence no longer
      // auto-ends the whole thing (confirmed ruling, reworked from the
      // original "always heals and ends immediately" behavior) - he grants
      // himself a small +1 checkpoint heal every time it lands on him (see
      // below), then becomes a REAL holder just like anyone else: his own
      // next turn, he gets a genuine choice between keep/pass/take (see
      // jesterBallResolution.keep below - his exclusive third option).
      // Only the FINAL landing (passCount reaching MAX_JESTER_BALL_PASSES,
      // or an earlier voluntary Take by anyone) decides the big outcome:
      // landing on Boingo there grants the full +4, landing on anyone else
      // explodes for damage - see the passCount-cap branch further down
      // and jesterBallResolution.keep's own "cash in on Take" path.
      // A landing that reaches MAX_JESTER_BALL_PASSES is the FINAL outcome
      // (full +4 below, not the smaller +1 checkpoint) - computed up front
      // so the checkpoint-heal branch can correctly skip itself on exactly
      // this one pass, avoiding a real double-heal bug (+1 checkpoint THEN
      // +4 final on the very same landing, confirmed via direct testing).
      const isFinalPass = game.jesterBall.passCount === MAX_JESTER_BALL_PASSES;
      let boingoCheckpointHeal = 0;
      let boingoWasKO = false;
      if (newHolderCharacterId === game.jesterBall.thrownByCharacterId && !isFinalPass) {
        boingoWasKO = game.characters[newHolderCharacterId]?.isKO ?? false;
        boingoCheckpointHeal = applyHeal(game, newHolderCharacterId, 1);
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
      // outcome, same as any other pass attempt. Boingo can't be BOTH the
      // checkpoint-heal target and the failed-pass-to-Illyra case in the
      // same call (those are two different newHolderCharacterId values),
      // so no interaction to worry about between the two branches.
      if (newHolderCharacterId === 'illyra' && Math.random() < 0.5) {
        log.push({ type: 'dodge', attackerId: fromCharacterId, targetCharacterId: 'illyra' });
        // Confirmed ruling: this must NEVER be Boingo himself - a failed
        // pass FROM Boingo TO Illyra should never explode 4 damage onto
        // Boingo. Boingo can never actually be fromCharacterId here in
        // practice anyway while ALSO being the one who'd take the
        // explosion (he'd need to be holding the ball and choosing to pass
        // it to Illyra himself) - guarded explicitly regardless, since
        // silently exploding on him would be a real, damaging bug if this
        // assumption is ever wrong. He just keeps holding it (as if the
        // pass attempt itself fizzled) rather than getting healed OR
        // exploded here.
        if (fromCharacterId === game.jesterBall.thrownByCharacterId) {
          return;
        }
        resolveExplosion(game, log, fromCharacterId);
        return;
      }
      game.jesterBall.holderCharacterId = newHolderCharacterId;
      if (!isFinalPass && (boingoCheckpointHeal > 0 || (newHolderCharacterId === game.jesterBall.thrownByCharacterId && boingoWasKO))) {
        log.push({ type: 'jester-ball-checkpoint-heal', boingoId: newHolderCharacterId, healed: boingoCheckpointHeal, wasKO: boingoWasKO });
      }
      // The final pass (reaching MAX_JESTER_BALL_PASSES) decides the big
      // outcome: Boingo gets the full +4 (same as the old dedicated
      // Return), anyone else explodes for the normal 4 damage.
      if (isFinalPass) {
        if (newHolderCharacterId === game.jesterBall.thrownByCharacterId) {
          const wasKO = game.characters[newHolderCharacterId]?.isKO ?? false;
          const healed = applyHeal(game, newHolderCharacterId, 4);
          log.push({ type: 'jester-ball-return', boingoId: newHolderCharacterId, healed, wasKO });
          game.jesterBall = null;
          return;
        }
        resolveExplosion(game, log, newHolderCharacterId);
        return;
      }
      log.push({ type: 'jester-ball-pass', fromCharacterId, toCharacterId: newHolderCharacterId });
    },
  },
  // Boingo-only third option (see index.js's handleJesterBallChoice, which
  // gates this to the current holder actually being Boingo): sit on the
  // ball for this turn without resolving it at all. Confirmed ruling: does
  // NOT consume his turn (he still gets a normal action, e.g. Chaos
  // Gamble, the same turn) and does NOT count toward
  // MAX_JESTER_BALL_PASSES - purely a "not yet" choice, the ball just
  // stays parked on him exactly as it was until a later turn where he
  // picks keep/pass/take again.
  keep: {
    label: 'Keep it for now',
    isLegal: () => true,
    execute(game, log) {
      // Deliberately a no-op - nothing about game.jesterBall changes.
      log.push({ type: 'jester-ball-keep', boingoId: game.jesterBall.holderCharacterId });
    },
  },
  take: {
    label: 'Take it',
    isLegal: () => true,
    execute(game, log) {
      return resolveExplosion(game, log, game.jesterBall.holderCharacterId);
    },
  },
};
