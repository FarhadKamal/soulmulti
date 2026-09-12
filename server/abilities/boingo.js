import { applyDamage, applyHeal, applyShield, tryTriggerCleanSlate } from '../engine/damagePipeline.js';
import { rollChaosGamble } from '../engine/random.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';

// KO-branch cleanup (see engine/categories/onOwnDeath.js). Fowl Play's
// countdown only ticks on BOINGO'S OWN turn (turnEngine.js's
// tickFowlPlayIfBoingoTurn) - but charactersActingThisTurn (turnEngine.js)
// filters out KO'd characters entirely, so a dead Boingo's turn never
// comes up again for the rest of the match. Left unhandled, that means
// game.fowlPlayActive would stay true FOREVER once he dies mid-window,
// permanently trapping every other survivor as a chicken with no way for
// the window to ever close - confirmed live report (2026-09-03): a match
// where Boingo died to a poison tick right after casting, and the
// remaining 3 players stayed chickenified for the rest of the match,
// which only ended because they fought each other to KO. Same class of
// bug/fix as Chronox's own onOwnDeath callback ending Time Freeze/World
// Stops immediately if HE dies mid-effect - confirmed ruling: "if boingo
// died cast immediatly over."
//
// Returns { fowlPlayRevertLogEntry } rather than pushing to `log` directly
// - this callback runs MID-WAY through applyDamage, before the triggering
// hit's own descriptive log line (e.g. a poison tick's own "takes 1
// poison damage - KO!"), so a direct push here would land the revert
// announcement BEFORE the line that actually caused it, backwards from
// a reader's expectation (confirmed bug, 2026-09-03). damagePipeline.js
// pulls this field out specially (NOT merged into the generic
// hitLandedCtxExtra bag, unlike Athena's own onOwnDeath return value) and
// defers it onto result.fowlPlayRevertLogEntry, same "defer it, don't
// push here" pattern as Rebirth's own result.rebirthLogEntry - the actual
// caller (finalizeAction/tickPoisonIfAny in turnEngine.js) pushes it
// AFTER their own line, stamping a fresh heartsSnapshot at that later
// point.
registerOnOwnDeath('boingo', (character, game, log) => {
  if (!game.fowlPlayActive) return undefined;
  game.fowlPlayActive = false;
  game.fowlPlayBoingoTurnsElapsed = 0;
  const revertedIds = [];
  for (const c of Object.values(game.characters)) {
    if (c.isChicken) {
      c.isChicken = false;
      revertedIds.push(c.id);
    }
  }
  // Resurrection Gamble (Draxus's Cheat Death, taxonomy #32) - a KO'd
  // Draxus who died WHILE chickenified never armed his eligibility (see
  // draxus.js's own registerOnOwnDeath guard: "so only normal koed image
  // we will give chance"). Now that Fowl Play has ended (Boingo's own
  // death is the SECOND of the two ways this can happen - see turnEngine.js's
  // tickFowlPlayIfBoingoTurn for the natural 3-turn-timer version) and his
  // real koed.jpg is showing again, arm it here. Inlined rather than
  // importing draxus.js directly - ability files never import each other,
  // only ever import FROM the engine, to avoid a circular-import risk.
  const draxusChar = game.characters.draxus;
  if (draxusChar && draxusChar.isKO && !draxusChar.isChicken && !draxusChar.special.cheatDeathEligible) {
    const others = Object.values(game.characters).filter((c) => c.id !== 'draxus' && !c.isKO);
    draxusChar.special.cheatDeathEligible = others.length >= 2;
  }
  // Prophecy of Doom (Oraclus, Death Pact #31 + Environmental Attack #2) -
  // same "fire the pending trigger now that Fowl Play has ended" reasoning
  // as the Draxus block above (confirmed ruling, 2026-09-07: "doom start
  // after boingo death"). Inlined for the same circular-import reason -
  // resolves the meteor strike directly (applyDamage is already imported
  // at the top of this file) rather than calling into oraclus.js.
  let prophecyOfDoomTriggerLogEntry;
  const oraclusChar = game.characters.oraclus;
  if (oraclusChar?.special?.prophecyOfDoomPendingAfterChicken) {
    oraclusChar.special.prophecyOfDoomPendingAfterChicken = false;
    const hits = [];
    // Local `log` array (the mid-applyDamage batch this whole callback
    // runs inside) is fine to pass through here - applyDamage's own
    // pushes onto it are themselves deferred/reordered correctly by the
    // SAME mechanism this trigger's own entry needs (see below), same
    // "collect real hit entries into the shared local batch, defer only
    // the summary/trigger entry itself" pattern Divine Judgment/this
    // trigger's own immediate-path counterpart in oraclus.js already use.
    for (const target of Object.values(game.characters)) {
      if (target.id === 'oraclus' || target.isKO) continue;
      const result = applyDamage(game, log, {
        sourceCharacterId: 'oraclus',
        targetCharacterId: target.id,
        amount: 3,
        ignoresDodge: true,
        ignoresUntargetable: true,
      });
      hits.push({ targetId: target.id, amountDealt: result.amountDealt, koTriggered: result.koTriggered });
    }
    if (hits.length > 0) {
      prophecyOfDoomTriggerLogEntry = { type: 'prophecy-of-doom-trigger', fromCharacterId: 'oraclus', hits };
    }
  }
  if (revertedIds.length === 0 && !prophecyOfDoomTriggerLogEntry) return undefined;
  return {
    ...(revertedIds.length > 0 ? { fowlPlayRevertLogEntry: { type: 'fowl-play-revert', characterIds: revertedIds } } : {}),
    ...(prophecyOfDoomTriggerLogEntry ? { prophecyOfDoomTriggerLogEntry } : {}),
  };
});

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
      // Confirmed ruling: the "win" roll's old +1 decaying shield bonus is
      // removed - a pure 3-damage hit now, no side benefit. His shield
      // reward comes from the reworked Jester Ball toll-booth instead (see
      // jesterBallResolution.pass's grantBoingoCheckpointReward below).
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
  // Fowl Play: hearts <= 3 gate, strictly one-time use (own dedicated
  // usedFowlPlay flag, separate from usedSpecial which is already spoken
  // for by Jester Ball) - confirmed ruling, replaces Massive Fart
  // entirely (retired the same session Fowl Play was designed).
  //
  // Turns EVERY OTHER living character (never Boingo himself) into a
  // chicken for FOWL_PLAY_BOINGO_TURNS of Boingo's OWN turns (confirmed
  // ruling, 2026-09-03: "wait for boingo three turn atleast" - fixed a
  // real gap where an earlier flat global-move-count version closed the
  // window right before Boingo's own next turn, so he never got a real
  // chance to attack a chicken). The countdown itself ticks in
  // turnEngine.js's beginCharacterTurn via tickFowlPlayIfBoingoTurn, only
  // on Boingo's own turns, reverting EVERY chickenified character at once
  // once it completes. While chickenified: every one of that character's
  // own actions is hidden, replaced by a single Chicken Attack (see
  // turnEngine.js's CHICKEN_ATTACK_ACTION/isValidTarget/
  // executeChickenAttack) that can only target another living chicken or
  // Boingo himself. Any in-progress state (banked charge, discovery
  // progress, active statuses) is left completely untouched - isChicken
  // is a pure action-availability gate, nothing more (confirmed ruling:
  // "anything pending such as studying will not waste... until become
  // hero again").
  fowlPlay: {
    label: 'Fowl Play',
    needsTarget: false,
    special: true,
    // Confirmed ruling, 2026-09-12: hidden entirely once no other living
    // character exists at all (mirrors Melyssa's own Full Control
    // isLegal), so the one-time special is never offered as a guaranteed
    // no-op when everyone else is already KO'd. Deliberately NOT narrowed
    // further to exclude a Clean-Slate-armed Marin - same reasoning as
    // Melyssa's own comment on this exact boundary: Clean Slate's armed/
    // immunity state is real per-cast side-effecting logic
    // (tryTriggerCleanSlate), not safe to peek at from a pure isLegal
    // check without actually consuming it. A cast that ends up blocking
    // its only candidate that way still correctly skips arming
    // fowlPlayActive (see execute() below), it just isn't preventable at
    // the button-legality level the way an empty-board case is.
    isLegal: (character, game) => character.hearts <= 3 && !character.special.usedFowlPlay
      && Object.values(game.characters).some((c) => c.id !== character.id && !c.isKO),
    execute(character, targetId, game, log) {
      character.special.usedFowlPlay = true;
      const candidates = Object.values(game.characters).filter((c) => c.id !== character.id && !c.isKO);
      // Marin's Clean Slate - confirmed ruling: "only marin clean slate
      // can protect her from chicken status" - the one exception in the
      // whole roster. Checked per-candidate the same way every other
      // status-inflicting ability already opts into tryTriggerCleanSlate
      // (Hidden Mark, Curse Strike, Time Freeze, Skull Crack, Silence
      // Lock) - blocks and consumes an armed Clean Slate (or is itself
      // blocked for the rest of her post-trigger immunity window),
      // pushing its own 'clean-slate-trigger' log entry. A blocked Marin
      // is excluded from the chicken pool entirely - never chickenified
      // at all this cast, not chickenified-then-immediately-reverted.
      const victims = candidates.filter((c) => !tryTriggerCleanSlate(c, game, log));
      for (const victim of victims) {
        victim.isChicken = true;
      }
      // Confirmed real bug, 2026-09-12: game.fowlPlayActive used to be set
      // true unconditionally, BEFORE the Clean Slate check even ran - so a
      // cast that ends up chickenifying literally no one (every candidate
      // Clean-Slate-blocked, or simply no other living character left)
      // still flipped the shared flag on, starting the chicken background
      // music and ticking down the full 3-turn window for zero visible
      // effect (live report: "but chicken music was continue" with an empty
      // "turned into chickens!" line). Only arm the window when at least
      // one real victim exists.
      if (victims.length > 0) {
        game.fowlPlayActive = true;
        game.fowlPlayBoingoTurnsElapsed = 0;
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'fowlPlay', chickenIds: victims.map((v) => v.id) });
      return {};
    },
  },
};

// Applies a Jester-Ball-landing-on-Boingo reward: heals him up to `amount`,
// and converts anything that would have overhealed (he's already at/near
// max hearts) into shield instead, point for point - confirmed ruling
// ("when heart is already 7 nothing to heal, then shield will stake +1
// each time", "final landing +4 life or even +4 shield, shield stack can
// even possible"). The shield is deliberately PERMANENT/stacking (no
// `decaying: true`) - only reduced by actually absorbing damage, unlike
// every other shield source in the game. Returns { healed, shielded } for
// the caller's own log entry.
function applyBoingoBallReward(game, characterId, amount) {
  const healed = applyHeal(game, characterId, amount);
  const overflow = amount - healed;
  if (overflow > 0) applyShield(game, characterId, overflow);
  return { healed, shielded: overflow };
}

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
      // next turn, he can Pass it on (Take was never offered to him - see
      // resolveExplosion's own comment). No dedicated "keep it" choice
      // either (removed 2026-08-31, confirmed redundant - a human can
      // already achieve the identical effect just by picking his normal
      // action, e.g. Chaos Gamble, directly instead of resolving the ball
      // at all that turn; the old Keep button/action was a genuine no-op
      // that changed nothing about game state, so it added no real choice
      // over simply not touching the ball).
      // Only the FINAL landing (passCount reaching MAX_JESTER_BALL_PASSES,
      // or an earlier voluntary Take by anyone) decides the big outcome:
      // landing on Boingo there grants the full +4, landing on anyone else
      // explodes for damage - see the passCount-cap branch further down.
      // A landing that reaches MAX_JESTER_BALL_PASSES is the FINAL outcome
      // (full +4 below, not the smaller +1 checkpoint) - computed up front
      // so the checkpoint-heal branch can correctly skip itself on exactly
      // this one pass, avoiding a real double-heal bug (+1 checkpoint THEN
      // +4 final on the very same landing, confirmed via direct testing).
      const isFinalPass = game.jesterBall.passCount === MAX_JESTER_BALL_PASSES;
      let boingoCheckpointHeal = 0;
      let boingoCheckpointShield = 0;
      let boingoWasKO = false;
      if (newHolderCharacterId === game.jesterBall.thrownByCharacterId && !isFinalPass) {
        boingoWasKO = game.characters[newHolderCharacterId]?.isKO ?? false;
        const reward = applyBoingoBallReward(game, newHolderCharacterId, 1);
        boingoCheckpointHeal = reward.healed;
        boingoCheckpointShield = reward.shielded;
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
        // A fumbled pass to Illyra means the ball never actually reaches
        // her - it detonates back on the passer instead, as if it fizzled
        // in their own hands (identical resolveExplosion rules as any
        // other explosion). On a NON-final pass this is just a normal mid-
        // chain explosion - EXCEPT if the passer is Boingo himself
        // (thrownByCharacterId), who must never take damage from his own
        // ball; he simply keeps holding it instead (pass attempt fizzles
        // with no consequence, no heal, no explosion).
        //
        // On the FINAL pass (isFinalPass), though, this fumble IS the
        // match's big outcome and must resolve exactly like any other
        // final landing - Boingo gets his full +4 reward if he's the
        // passer, anyone else explodes for 4. Originally this branch
        // returned early with a no-op for a Boingo-final-pass fumble,
        // which left game.jesterBall stuck forever (isFinalPass true, so
        // pass's own isLegal - passCount < MAX - became permanently false,
        // and holderCharacterId was never reassigned) - confirmed live bug
        // report: "failed to land on illyra due to illusion... staying on
        // boingo portrait... pass is over... we missed 4 heal or 4 damage
        // explosion". Fixed by branching on isFinalPass here too, same as
        // the normal (non-fumble) final-pass branch below.
        if (fromCharacterId === game.jesterBall.thrownByCharacterId) {
          if (isFinalPass) {
            const wasKO = game.characters[fromCharacterId]?.isKO ?? false;
            const { healed, shielded } = applyBoingoBallReward(game, fromCharacterId, 4);
            log.push({ type: 'jester-ball-return', boingoId: fromCharacterId, healed, shielded, wasKO });
            game.jesterBall = null;
          }
          return;
        }
        resolveExplosion(game, log, fromCharacterId);
        return;
      }
      game.jesterBall.holderCharacterId = newHolderCharacterId;
      // The pass itself (the action) is logged BEFORE any consequence of
      // where it landed (checkpoint reward, final reward, or an explosion)
      // - confirmed live report: the reward line was appearing ABOVE "X
      // passed the ball to Y" in the match log, reading backwards ("he got
      // the reward" before "the ball even arrived"). Every one of this
      // pass's own possible follow-up entries (checkpoint-heal below, or
      // the final-landing/explosion branch further down) now pushes AFTER
      // this line instead of before it.
      if (!isFinalPass) {
        log.push({ type: 'jester-ball-pass', fromCharacterId, toCharacterId: newHolderCharacterId });
      }
      if (!isFinalPass && (boingoCheckpointHeal > 0 || boingoCheckpointShield > 0 || (newHolderCharacterId === game.jesterBall.thrownByCharacterId && boingoWasKO))) {
        log.push({ type: 'jester-ball-checkpoint-heal', boingoId: newHolderCharacterId, healed: boingoCheckpointHeal, shielded: boingoCheckpointShield, wasKO: boingoWasKO });
      }
      // The final pass (reaching MAX_JESTER_BALL_PASSES) decides the big
      // outcome: Boingo gets the full +4 worth of reward (heal, or shield
      // for whatever part overflows past max hearts - same
      // applyBoingoBallReward helper as the checkpoint case), anyone else
      // explodes for the normal 4 damage. No separate jester-ball-pass
      // entry for this one - the return/explosion entry itself already
      // names both the ball's arrival and its outcome in one line.
      if (isFinalPass) {
        if (newHolderCharacterId === game.jesterBall.thrownByCharacterId) {
          const wasKO = game.characters[newHolderCharacterId]?.isKO ?? false;
          const { healed, shielded } = applyBoingoBallReward(game, newHolderCharacterId, 4);
          log.push({ type: 'jester-ball-return', boingoId: newHolderCharacterId, healed, shielded, wasKO });
          game.jesterBall = null;
          return;
        }
        resolveExplosion(game, log, newHolderCharacterId);
        return;
      }
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
