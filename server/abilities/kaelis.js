import { applyDamage, applyHeal } from '../engine/damagePipeline.js';

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
      // attacker landed on her (see damagePipeline.js's applyDamage) adds 1.
      // Landing a Grudge Strike against a grudged target deals damage equal
      // to their current count (e.g. 5 accumulated hits -> 5 damage here),
      // then resets THAT attacker's count back to 0 - every other
      // attacker's count stays independently intact. No count (0/absent)
      // means a plain 1 damage hit, same as before.
      const grudgeCount = character.special.grudgeCounts.get(targetId) || 0;
      const wasGrudged = grudgeCount > 0;
      if (wasGrudged) character.special.grudgeCounts.set(targetId, 0);
      const amount = wasGrudged ? grudgeCount : 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grudgeStrike', targetId, wasGrudged, grudgeCount, ...result });
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
