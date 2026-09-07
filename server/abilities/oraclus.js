import { applyDamage } from '../engine/damagePipeline.js';
import { registerOnAnyDeath } from '../engine/categories/onAnyDeath.js';

const PROPHECY_OF_DOOM_HEARTS_THRESHOLD = 3;
const PROPHECY_OF_DOOM_DAMAGE = 3;

// Actually resolves the meteor strike - 3 damage to every OTHER living
// character at once. Shared by both firing paths: the immediate trigger
// below (Oraclus dies NOT chickenified) and the delayed one in
// turnEngine.js/boingo.js (he died WHILE chickenified - see
// prophecyOfDoomPendingAfterChicken's own comment for why that case can't
// fire immediately).
function resolveProphecyOfDoomStrike(game, log) {
  const hits = [];
  for (const target of Object.values(game.characters)) {
    if (target.id === 'oraclus' || target.isKO) continue;
    // Environmental Attack shape (confirmed rulings): bypasses Dodge
    // Defense and Untargetable entirely (nobody can evade a falling
    // meteor), but Shield Defense still applies normally ("it respects
    // shield") - NOT ignoresShield, unlike Athena's own Pure-Attack-shaped
    // trigger. Draxus's immortal floor and Blade's Rebirth also still
    // function normally against this specific hit (confirmed ruling - the
    // one place this diverges from Divine Judgment, which explicitly
    // bypasses both) - so ignoresImmortal/ignoresRebirth are deliberately
    // NOT set here either.
    const result = applyDamage(game, log, {
      sourceCharacterId: 'oraclus',
      targetCharacterId: target.id,
      amount: PROPHECY_OF_DOOM_DAMAGE,
      ignoresDodge: true,
      ignoresUntargetable: true,
    });
    hits.push({ targetId: target.id, amountDealt: result.amountDealt, koTriggered: result.koTriggered });
  }
  if (hits.length === 0) return null;
  return { type: 'prophecy-of-doom-trigger', fromCharacterId: 'oraclus', hits };
}

// Called from turnEngine.js's own 3-turn Fowl Play timer
// (tickFowlPlayIfBoingoTurn, via beginCharacterTurn) - mirrors draxus.js's
// armCheatDeathIfNewlyRevealed exactly, same underlying reasoning
// (confirmed ruling, 2026-09-07: "if chicken status, oraclus fried and
// koed. doom start after boingo death"). Fires the meteor strike NOW if it
// was left pending from a chicken-window death, pushing directly to `log`
// - safe here because this call path's `log` IS game.log itself (passed
// straight through from gameFlow.js's beginCharacterTurn call), not a
// local mid-applyDamage batch awaiting deferral.
export function firePendingProphecyOfDoomIfAny(game, log) {
  const oraclus = game.characters.oraclus;
  if (!oraclus?.special?.prophecyOfDoomPendingAfterChicken) return;
  oraclus.special.prophecyOfDoomPendingAfterChicken = false;
  const entry = resolveProphecyOfDoomStrike(game, log);
  if (entry) log.push(entry);
}

// Called from boingo.js's own registerOnOwnDeath callback - the OTHER way
// Fowl Play can end (Boingo dying mid-window). UNLIKE the function above,
// this path runs MID-WAY through applyDamage (Boingo's own death, before
// the caller's own log.push() for its attack line) - same timing risk
// fowlPlayRevertLogEntry itself already has to defer around, so this
// resolves the strike and RETURNS the entry instead of pushing directly,
// for damagePipeline.js to pull out and defer the same way.
export function resolvePendingProphecyOfDoomForBoingoDeath(game, log) {
  const oraclus = game.characters.oraclus;
  if (!oraclus?.special?.prophecyOfDoomPendingAfterChicken) return undefined;
  oraclus.special.prophecyOfDoomPendingAfterChicken = false;
  const entry = resolveProphecyOfDoomStrike(game, log);
  return entry ? { prophecyOfDoomTriggerLogEntry: entry } : undefined;
}

// Prophecy of Doom (Death Pact category #31 + Environmental Attack #2, see
// project memory soulclash_oraclus_prophecy_of_doom.md) - the instant HE
// dies, a meteor strike deals 3 damage to EVERY other living character at
// once (not one chosen victim, unlike Athena's own Divine Judgment - the
// key structural difference between the two Death Pact abilities in the
// roster). Uses onAnyDeath (not onOwnDeath) for the same reason Athena's
// own trigger does: this needs to call applyDamage again on OTHER
// characters after Oraclus's own death is already fully resolved
// (isKO/hearts already settled), which onOwnDeath's mid-applyDamage
// callback timing isn't the right shape for. Confirmed ruling: no
// exception for whoever/whatever delivered the killing blow - it still
// fires regardless of source.
//
// Chicken exception (confirmed ruling, 2026-09-07, same reasoning as
// Draxus's own Cheat Death eligibility gate): if Oraclus dies WHILE
// chickenified, his portrait shows chicken_roast.jpg, not his real
// koed.jpg - the meteor strike must NOT fire immediately in that case.
// Instead it's parked in prophecyOfDoomPendingAfterChicken and fired later
// by firePendingProphecyOfDoomIfAny above, once Fowl Play actually ends
// and his real koed.jpg is showing again.
registerOnAnyDeath((diedCharacterId, sourceCharacterId, isMirror, game, log) => {
  if (diedCharacterId !== 'oraclus') return;
  const oraclus = game.characters.oraclus;
  if (!oraclus?.special?.prophecyOfDoomArmed) return;
  oraclus.special.prophecyOfDoomArmed = false;
  if (oraclus.isChicken) {
    oraclus.special.prophecyOfDoomPendingAfterChicken = true;
    return undefined;
  }
  const entry = resolveProphecyOfDoomStrike(game, log);
  if (!entry) return undefined;
  // Deferred (returned, not pushed to `log` here) - same reasoning as
  // Athena's own divineJudgmentTriggerLogEntry: this callback runs
  // mid-way through the OUTER applyDamage call (whatever action actually
  // delivered Oraclus's own killing blow), before that caller's own
  // log.push() for its attack line, so pushing directly here would land
  // this entry BEFORE the triggering attack's own line instead of after
  // it. Every deferred-push call site that already handles
  // divineJudgmentTriggerLogEntry (finalizeAction, tickPoisonIfAny,
  // resolveJesterBall, resolveFullControl's loop) needs the same handling
  // added for this new field too, or it's silently dropped, not just
  // misordered.
  return { prophecyOfDoomTriggerLogEntry: entry };
});

export const actions = {
  runeStrike: {
    label: 'Rune Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // Base 1 damage + a permanent, non-decaying +1 per correct Rune
      // Vision prediction (max +2, once both wins are banked) - confirmed
      // ruling. This is the whole reason his base damage stays deliberately
      // low: the growth is meant to come from successfully predicting, not
      // from the basic attack alone.
      const amount = 1 + character.special.runeStrikeBonusDamage;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'runeStrike', targetId, amount, ...result });
      return result;
    },
  },
  // Stage 1 of Rune Vision: pick the predicted ATTACKER. needsTarget: true
  // here means the CLIENT'S normal single-target picker is reused for this
  // first pick (targetId carries the predicted attacker's id) - stage 2
  // (picking the predicted TARGET) is a distinct follow-up decision
  // resolved server-side in index.js, same two-stage pattern as Soul
  // Swap's free Thunder Wrath follow-up (see zerathys.js/index.js's
  // awaitingSoulSwapWrath handling).
  //
  // Legal only while 3-4 total characters (including Oraclus himself) are
  // alive (confirmed ruling - too easy to guess correctly in a straight
  // 1v1/1v2), and only while he hasn't already banked 2 wins (the ability
  // permanently retires after that - confirmed ruling). Unlimited casts
  // otherwise - no usedSpecial gate, no cooldown; a wrong guess costs
  // nothing but the turn spent on it.
  runeVision: {
    label: 'Rune Vision',
    needsTarget: true,
    special: true,
    isLegal: (character, game) => {
      if (character.special.predictionWins >= 2) return false;
      const livingCount = Object.values(game.characters).filter((c) => !c.isKO).length;
      return livingCount === 3 || livingCount === 4;
    },
    execute(character, targetId, game, log) {
      // Stores the predicted attacker only - stage 2 (picking the
      // predicted target) fills in predictedTargetId separately, once the
      // human/bot has made that second choice (see index.js's
      // handleRuneVisionTargetPick / botPlayer.js's equivalent). This
      // execute() call is ONLY reached for stage 1; index.js intercepts
      // the actionId before ever calling executeAction a second time for
      // stage 2, writing predictedTargetId directly instead - there is no
      // second "runeVisionTarget" action definition needed here, unlike
      // Soul Swap's soulSwapWrath, because stage 2 never deals damage or
      // needs its own isLegal/execute pass through the normal ability
      // pipeline.
      character.special.predictedAttackerId = targetId;
      character.special.predictedTargetId = null;
      log.push({ type: 'special', characterId: character.id, actionId: 'runeVision', predictedAttackerId: targetId, stage: 1 });
      return { awaitingTargetPick: true };
    },
  },
  // Prophecy of Doom: his hearts<=3 desperation special (Death Pact #31 +
  // Environmental Attack #2, see project memory
  // soulclash_oraclus_prophecy_of_doom.md). Cast does NOTHING immediately -
  // no target, no damage, no status on anyone - purely arms
  // prophecyOfDoomArmed for the registerOnAnyDeath trigger above.
  // Deliberately unblockable at cast (no target at all, so
  // tryTriggerCleanSlate/tryIllyraDodgeStatus don't even apply here the way
  // they do for a targeted status like Curse Strike/Divine Judgment) and
  // uncleansable afterward (prophecyOfDoomArmed lives on Oraclus's OWN
  // special object, not referencing another character by id, so it's
  // naturally outside hasNegativeStatus/clearNegativeStatuses's scan shape
  // without needing an explicit exclusion the way Divine Judgment/Poison
  // Cloud needed one). One-time use only (confirmed ruling).
  prophecyOfDoom: {
    label: 'Prophecy of Doom',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= PROPHECY_OF_DOOM_HEARTS_THRESHOLD && !character.special.usedProphecyOfDoom,
    execute(character, targetId, game, log) {
      character.special.usedProphecyOfDoom = true;
      character.special.prophecyOfDoomArmed = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'prophecyOfDoom' });
      return {};
    },
  },
};
