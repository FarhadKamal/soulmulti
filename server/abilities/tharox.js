import { applyDamage, applyHeal, applyShield, decayShieldIfDue } from '../engine/damagePipeline.js';

export function onTurnStart(character, game, log) {
  decayShieldIfDue(character);
}

export const actions = {
  smash: {
    label: 'Smash',
    needsTarget: true,
    isLegal: (character) => !character.special.hasCharge,
    execute(character, targetId, game, log) {
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 1,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'smash', targetId, ...result });
      return result;
    },
  },
  titanToss: {
    label: 'Titan Toss',
    needsTarget: false,
    isLegal: (character) => !character.special.hasCharge,
    execute(character, targetId, game, log) {
      character.special.hasCharge = true;
      log.push({ type: 'setup', characterId: character.id, actionId: 'titanToss' });
      return {};
    },
  },
  titanSmash: {
    label: 'Titan Smash',
    needsTarget: true,
    isLegal: (character) => character.special.hasCharge,
    execute(character, targetId, game, log) {
      character.special.hasCharge = false;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 3,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'titanSmash', targetId, ...result });
      return result;
    },
  },
  glorySmash: {
    label: 'Glory Smash',
    needsTarget: true,
    isLegal: (character) => character.special.hasCharge && !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      // Consumes the current charge and grants a brand-new one.
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 2,
      });
      applyHeal(game, character.id, 2);
      applyShield(game, character.id, 2, { decaying: true });
      character.special.hasCharge = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'glorySmash', targetId, ...result });
      return result;
    },
  },
};
