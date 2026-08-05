import { applyHeal, applyShield, decayShieldIfDue } from '../engine/damagePipeline.js';

export function onTurnStart(character, game, log) {
  decayShieldIfDue(character);
}

export const actions = {
  curseStrike: {
    label: 'Curse Strike',
    needsTarget: true, // target here is a CHARACTER belonging to the player being cursed
    isLegal: () => true,
    execute(character, targetId, game, log) {
      character.special.curseTargetCharacterId = targetId;
      log.push({ type: 'curse', characterId: character.id, targetId });
      return {};
    },
  },
  divineRestore: {
    label: 'Divine Restore',
    needsTarget: false,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      applyHeal(game, character.id, 3);
      applyShield(game, character.id, 2, { decaying: true });
      log.push({ type: 'special', characterId: character.id, actionId: 'divineRestore' });
      return {};
    },
  },
};
