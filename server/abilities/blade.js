import { applyDamage } from '../engine/damagePipeline.js';

export const actions = {
  bloodHunt: {
    label: 'Blood Hunt',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      if (character.special.streakTargetId === targetId) {
        character.special.streakCount += 1;
      } else {
        character.special.streakTargetId = targetId;
        character.special.streakCount = 1;
      }
      const amount = character.special.streakCount;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'bloodHunt', targetId, streak: character.special.streakCount, ...result });
      return result;
    },
  },
};
