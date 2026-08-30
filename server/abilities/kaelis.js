import { applyDamage, applyHeal } from '../engine/damagePipeline.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';

// Grudge accumulation (see engine/categories/onHitLanded.js): whenever a
// REAL (non-mirrored) hit lands on her, that attacker's per-attacker hit
// COUNT increments by 1 - a stacking counter, not a boolean flag, so 5 hits
// before she retaliates means her next Grudge Strike against that attacker
// deals 5 damage (see grudgeStrike below). Reset to 0 only when SHE later
// lands a Grudge Strike against that same attacker, or when that attacker
// revives (see this file's own onOtherRevived registration above).
// isPoisonTick excluded: Poison Cloud is a single cast ("one attack") that
// then deals passive recurring damage on the victim's own turns with no
// further action from the caster - only the initial cast should register
// as a grudge-worthy attack, not every tick afterward (confirmed bug fix -
// a Kaelis poisoned by Rowan was previously racking up a fresh grudge
// point on every single tick).
registerOnHitLanded('kaelis', (character, game, log, ctx) => {
  if (ctx.isMirror || ctx.isPoisonTick || ctx.amountDealt <= 0 || ctx.sourceCharacterId === 'kaelis') return;
  const counts = character.special.grudgeCounts;
  counts.set(ctx.sourceCharacterId, (counts.get(ctx.sourceCharacterId) || 0) + 1);
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - her grudge
// COUNT against a now-revived character doesn't carry over; they come back
// "fresh," same reasoning as every other stale-reference cleanup. Deleting
// the map key is equivalent to resetting the count to 0
// (grudgeCounts.get() falls back to 0 for an absent key).
registerOnOtherRevived((revivedCharacterId, game) => {
  const kaelis = game.characters.kaelis;
  if (kaelis) kaelis.special.grudgeCounts.delete(revivedCharacterId);
});

// Bird heal ticks fire on Kaelis's own onTurnStart, unconditionally - this
// runs BEFORE any freeze/skip check (turnEngine.js's beginCharacterTurn
// calls onTurnStart before consumeSkipIfFrozen), so the heal still lands
// even on a turn where she ends up frozen/skipped. Cast turn (callAshka's
// own execute, below) heals immediately and sets ashkaHealsRemaining = 2 -
// this hook only covers the 2 FOLLOW-UP heals, which do not consume her
// turn (she still acts/skips normally alongside the heal).
export function onTurnStart(character, game, log) {
  if (character.special.ashkaHealsRemaining > 0) {
    const healed = applyHeal(game, character.id, 2);
    character.special.ashkaHealsRemaining -= 1;
    log.push({ type: 'ashka-heal', characterId: character.id, healed });
  }
}

export const actions = {
  grudgeStrike: {
    label: 'Grudge Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // A per-attacker hit COUNTER, not a boolean flag - each real hit that
      // attacker landed on her (see damagePipeline.js's applyDamage) adds 1
      // to THEIR OWN count, independent of every other attacker's. Damage
      // here is always the base 1 PLUS that attacker's stored count (e.g.
      // 1 stored hit -> 1+1=2 damage; 0 stored hits -> just the base 1) -
      // the base damage is never replaced, only topped up. Landing a
      // Grudge Strike against ANY target always resets THAT target's count
      // back to 0 afterward (even if it was already 0) - every other
      // attacker's count stays untouched.
      const grudgeCount = character.special.grudgeCounts.get(targetId) || 0;
      const amount = 1 + grudgeCount;
      character.special.grudgeCounts.set(targetId, 0);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grudgeStrike', targetId, wasGrudged: grudgeCount > 0, grudgeCount, ...result });
      return result;
    },
  },
  callAshka: {
    label: 'Call Ashka',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      const healed = applyHeal(game, character.id, 2);
      // 2, not 3 - this cast turn's own heal already happened above; this
      // count is only for the 2 FOLLOW-UP turns (see onTurnStart).
      character.special.ashkaHealsRemaining = 2;
      log.push({ type: 'special', characterId: character.id, actionId: 'callAshka', healed });
      return {};
    },
  },
};
