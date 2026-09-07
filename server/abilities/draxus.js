import { applyDamage, heartsSnapshot, clearNegativeStatuses, isFrozenByChronox } from '../engine/damagePipeline.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { runOnOtherRevived } from '../engine/categories/onOtherRevived.js';

const DYING_BLOW_TIERS = [
  { min: 6, amount: 1 },
  { min: 4, amount: 2 },
  { min: 1, amount: 3 },
];

function dyingBlowAmount(hearts) {
  const tier = DYING_BLOW_TIERS.find((t) => hearts >= t.min);
  return tier ? tier.amount : 1;
}

// Resurrection Gamble (taxonomy #32, design-locked 2026-09-06, see project
// memory soulclash_draxus_new_ability_design.md): the odds of a successful
// Cheat Death roll. Confirmed final base value, 2026-09-06 (was bumped to 1
// for live testing, then reverted back to this).
//
// Escalating odds, confirmed ruling 2026-09-07: the chance climbs +5% per
// FAILED attempt within the same death-cycle (25% -> 30% -> 35% -> ...),
// uncapped ("no cap"), resetting back to the base 25% both on a fresh KO
// and on a successful revival - see cheatDeathAttemptCount in state.js.
export const CHEAT_DEATH_REVIVE_CHANCE = 0.25;
export const CHEAT_DEATH_REVIVE_CHANCE_STEP = 0.05;
export const CHEAT_DEATH_REVIVE_HEARTS = 1;

function currentCheatDeathChance(character) {
  return CHEAT_DEATH_REVIVE_CHANCE + character.special.cheatDeathAttemptCount * CHEAT_DEATH_REVIVE_CHANCE_STEP;
}

// True whenever there are at least 2 OTHER living characters besides
// Draxus himself - the stop condition (confirmed ruling: rolling continues
// "until 2 different char alive" [besides him]). Below this, offering him
// another Cheat Death turn would either be pointless (a genuine 1v1 - "in
// 1 v 1 situation... if draxus koed. its over", so this never even arms in
// the first place) or would indefinitely stall a match that's otherwise
// already decided (only 1 other living character left, everyone else
// already KO'd including him).
function hasEnoughSurvivorsForCheatDeath(game) {
  const others = Object.values(game.characters).filter((c) => c.id !== 'draxus' && !c.isKO);
  return others.length >= 2;
}

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - fires exactly
// once, the instant Draxus's own hearts first reach 0 and isKO flips true
// inside applyDamage's KO branch. Arms (or leaves un-armed) his Cheat Death
// eligibility for this new "dead but rolling" cycle - re-armed on every one
// of his deaths this match, not just the first (confirmed ruling: "this
// 25% chance continue. he can get koed multiple time").
//
// Confirmed ruling, 2026-09-06: a Draxus who dies WHILE chickenified
// (Boingo's Fowl Play, isChicken true) shows chicken_roast.jpg, not his own
// normal koed.jpg - "so only normal koed image we will give chance". He
// must NOT become eligible to roll while still a fried chicken - only once
// Fowl Play ends and he's showing his real koed.jpg does the chance apply.
registerOnOwnDeath('draxus', (character, game) => {
  // New death-cycle - escalation resets to the base chance (confirmed
  // ruling: "if he die again it will start from 25%").
  character.special.cheatDeathAttemptCount = 0;
  if (character.isChicken) return;
  character.special.cheatDeathEligible = hasEnoughSurvivorsForCheatDeath(game);
});

// Called from BOTH places Fowl Play can end (turnEngine.js's own 3-turn
// timer, and boingo.js's registerOnOwnDeath if Boingo himself dies
// mid-window) - the moment a KO'd Draxus stops being chickenified, his real
// koed.jpg is showing again, so this is when Cheat Death eligibility should
// actually arm for the first time if he died while still a chicken
// (skipped entirely by the onOwnDeath callback above in that case).
// Confirmed ruling: "boingo have to die. when he die koed image normal
// back to our current. that is already their. so only normal koed image we
// will give chance" - same reasoning covers the natural 3-turn timer end,
// not just Boingo's own death specifically.
export function armCheatDeathIfNewlyRevealed(game) {
  const character = game.characters.draxus;
  if (!character || !character.isKO || character.isChicken) return;
  if (character.special.cheatDeathEligible) return; // already armed, nothing to do
  character.special.cheatDeathEligible = hasEnoughSurvivorsForCheatDeath(game);
}

// Fires exactly once at the start of his own turn (gated by
// game.turnStartFiredFor in gameFlow.js's getActingCharacterId, so this
// never re-fires mid-way through his own 3-strike bonus turn). This is
// where the death-proof window ends and, if it was active, the bonus turn
// is granted. If Deathless Fury was never cast (or already consumed), this
// is a no-op every other turn.
//
// Also where reviveImmortalActive's own one-turn-delayed clear happens
// (confirmed ruling: "immortal will stay untill his second turn come") -
// same shape as deathproofActive just above, a SEPARATE flag since the two
// windows are conceptually distinct (a proactive cast vs. an automatic
// post-revival state) even though they can never be active at once in
// practice. Fires on this SAME call as the eligibility re-check below,
// since both are "things that resolve at the start of his own next turn."
export function onTurnStart(character, game, log) {
  if (character.special.deathproofActive) {
    character.special.deathproofActive = false;
    character.special.bonusActionsRemaining = 3;
    log.push({ type: 'deathless-fury-end', characterId: character.id, hearts: heartsSnapshot(game) });
  }
  // Fixed 2026-09-07 (found via a live match log): onTurnStart fires the
  // instant getActingCharacterId reaches him, EVEN on a turn that's about
  // to be skipped for being frozen (gameFlow.js runs beginCharacterTurn
  // before its own freeze-skip check, deliberately, for other mechanics
  // like Mirror Reflect/poison ticks that need to fire regardless). A
  // frozen turn isn't a REAL turn he got to act on, so it must NOT count
  // toward "his own next turn" for reviveImmortalActive's clear - confirmed
  // bug: a Draxus revived then immediately frozen by World Stops had his
  // immortality clear on the very next (frozen, skipped) turn, then died
  // for real to a hit that landed before he ever got a genuine turn back.
  if (character.special.reviveImmortalActive && !isFrozenByChronox(character, game)) {
    character.special.reviveImmortalActive = false;
  }
  // While he's still KO'd and eligible, his own "turn" is the Cheat Death
  // roll itself (see gameFlow.js's getActingCharacterId, which returns him
  // here instead of skipping) - re-check the stop condition fresh every
  // time this turn comes up, since other players may have died in the
  // meantime and dropped the survivor count below 2 since he last rolled.
  if (character.isKO && character.special.cheatDeathEligible && !hasEnoughSurvivorsForCheatDeath(game)) {
    character.special.cheatDeathEligible = false;
  }
}

// Cheat Death: the single button offered on a KO'd, still-eligible
// Draxus's own turn (see turnEngine.js's getLegalActions/executeAction,
// which dispatch here the same way Fowl Play's chickenAttack is handled -
// not declared in the `actions` map below since it only ever applies while
// he's actually dead, unlike every real entry there which implicitly
// assumes a living character).
export function executeCheatDeath(character, game, log) {
  const chance = currentCheatDeathChance(character);
  const success = Math.random() < chance;
  if (!success) {
    // Escalates the NEXT attempt's odds - confirmed ruling: "first turn
    // try 25% next turn 30% next turn 35%..." (uncapped within this same
    // death-cycle; resets to 0 on his next actual death via
    // registerOnOwnDeath above, or on a success just below).
    character.special.cheatDeathAttemptCount += 1;
    log.push({ type: 'cheat-death', characterId: character.id, success: false, chance, hearts: heartsSnapshot(game) });
    return {};
  }
  character.isKO = false;
  character.hearts = CHEAT_DEATH_REVIVE_HEARTS;
  character.special.cheatDeathEligible = false;
  character.special.cheatDeathAttemptCount = 0;
  character.special.reviveImmortalActive = true;
  character.special.hasRevivedOnce = true;
  // "Fresh copy" reset, same pattern as Rebirth's own revival (see
  // registerRebirth('blade', ...) in blade.js) - confirmed ruling:
  // "remember after alive fresh copy like we did example for rebirth", then
  // "fresh means negative status will remove". Clears every negative
  // status CURRENTLY on him (curse, freeze/world-stops, marks, silence,
  // headache, poison, grudge counts against him - clearNegativeStatuses
  // covers curse/freeze/world-stops/marks/silence/headache; poison/grudge/
  // mirage-stack cleanup for the OTHER caster's own side lives in each of
  // THEIR ability modules' own registerOnOtherRevived callbacks, invoked
  // below) plus his own transient self-state.
  clearNegativeStatuses(character, game, log);
  character.skipNextTurn = false;
  character.skipHeadacheTurn = false;
  // Every OTHER character's stale reference to him (a pending headache
  // roll aimed at him, a banked grudge count, poison tracking, a stale
  // Rewind snapshot, Grimtal's own kill-credit bookkeeping) is handled
  // generically here - see each affected character's own onOtherRevived
  // registration, same dispatch Blade's Rebirth already triggers.
  runOnOtherRevived(character.id, game, log);
  log.push({ type: 'cheat-death', characterId: character.id, success: true, chance, hearts: heartsSnapshot(game) });
  return { revived: true };
}

export const actions = {
  dyingBlow: {
    label: 'Dying Blow',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // Captured BEFORE index.js's post-action bonusActionsRemaining
      // decrement runs - true for all 3 of his bonus-turn strikes, false
      // for a completely normal turn. strikeNumber (1-based) lets the
      // client play the right One/Two/Three voice line and immortal_strike
      // flash - 3 remaining -> strike 1, 2 remaining -> strike 2, 1
      // remaining -> strike 3.
      const isBonusStrike = character.special.bonusActionsRemaining > 0;
      const strikeNumber = isBonusStrike ? 4 - character.special.bonusActionsRemaining : null;
      const amount = dyingBlowAmount(character.hearts);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'dyingBlow', targetId, isBonusStrike, strikeNumber, ...result });
      return result;
    },
  },
  deathlessFury: {
    label: 'Deathless Fury',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      character.special.deathproofActive = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'deathlessFury' });
      return {};
    },
  },
};
