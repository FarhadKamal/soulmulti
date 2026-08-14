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
      // A per-attacker boolean-style flag (Set), not a stacking counter -
      // being hit multiple times by the same attacker before she retaliates
      // just keeps them "armed," never escalates the revenge damage.
      // Armed in damagePipeline.js's applyDamage whenever a real hit lands
      // on her; cleared here, and ONLY here, the moment she lands a Grudge
      // Strike against that specific attacker - every other attacker's flag
      // stays independently armed.
      const wasGrudged = character.special.grudgedAttackerIds.has(targetId);
      if (wasGrudged) character.special.grudgedAttackerIds.delete(targetId);
      const amount = wasGrudged ? 2 : 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grudgeStrike', targetId, wasGrudged, ...result });
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
