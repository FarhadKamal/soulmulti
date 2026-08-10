import { applyDamage } from '../engine/damagePipeline.js';

// Lunar Eclipse: flat 3-attack duration, no coin flip. Untargetable covers
// her next 3 attacks after casting, then ends automatically.
function maybeEndEclipse(character, log) {
  if (!character.untargetable) return;
  character.special.eclipseAttacksSinceCast += 1;
  if (character.special.eclipseAttacksSinceCast < 3) return;
  character.untargetable = false;
  log.push({ type: 'eclipse-end', characterId: character.id });
}

export const actions = {
  lunarStrike: {
    label: 'Lunar Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      character.special.hasActedOnce = true;
      character.special.lastTargetId = targetId;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 1,
        ignoresShield: true,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'lunarStrike', targetId, ...result });
      maybeEndEclipse(character, log);
      return result;
    },
  },
  moonstep: {
    label: 'Moonstep',
    needsTarget: true,
    isLegal: (character) => character.special.hasActedOnce,
    execute(character, targetId, game, log) {
      // No bonus on her first-ever real attack (e.g. opened with Lunar
      // Eclipse instead of Lunar Strike) - lastTargetId is null then, and
      // that must NOT count as "a different target" for the -2 bonus.
      const isNewTarget = character.special.lastTargetId !== null
        && character.special.lastTargetId !== targetId;
      const amount = isNewTarget ? 2 : 1;
      character.special.lastTargetId = targetId;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
        ignoresShield: true,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'moonstep', targetId, isNewTarget, ...result });
      maybeEndEclipse(character, log);
      return result;
    },
  },
  lunarEclipse: {
    label: 'Lunar Eclipse',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      character.untargetable = true;
      character.special.hasActedOnce = true;
      character.special.eclipseAttacksSinceCast = 0;
      log.push({ type: 'special', characterId: character.id, actionId: 'lunarEclipse' });
      return {};
    },
  },
};
