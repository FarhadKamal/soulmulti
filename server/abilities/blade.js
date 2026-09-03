import { applyDamage, registerRebirth } from '../engine/damagePipeline.js';

// Rebirth: automatic, intercepts the KO the instant it would happen (see
// damagePipeline.js's KO branch, which calls this registered reset instead
// of hand-rolling Blade's own state reset inline). Only his OWN state is
// reset here - every OTHER character's stale reference to him (curse,
// freeze, marks, grudge, poison, headache, mirage stacks, a stale Rewind
// snapshot) is handled generically by onOtherRevived callbacks, one per
// affected character's own ability module (see
// engine/categories/onOtherRevived.js and each of those files' own
// registration).
registerRebirth('blade', (character) => {
  character.hearts = 2;
  character.special.rebirthUsed = true;
  character.usedSpecial = true;
  // Comes back fresh: clear any lingering negative status rather than
  // carrying it over from the moment he died.
  character.skipNextTurn = false;
  character.skipHeadacheTurn = false;
  character.special.streakTargetId = null;
  character.special.streakCount = 0;
});

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
