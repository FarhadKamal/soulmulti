import { applyHeal, applyShield, decayShieldIfDue, tryTriggerCleanSlate } from '../engine/damagePipeline.js';

export function onTurnStart(character, game, log) {
  decayShieldIfDue(character);
}

export const actions = {
  curseStrike: {
    label: 'Curse Strike',
    needsTarget: true, // target here is a CHARACTER belonging to the player being cursed
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the curse itself rather than
      // letting it land - the cast still happens (this counts as her turn),
      // it just has no lasting effect on the target.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'curse', characterId: character.id, targetId, blocked: true });
        return {};
      }
      character.special.curseTargetCharacterId = targetId;
      log.push({ type: 'curse', characterId: character.id, targetId });
      return {};
    },
  },
  divineRestore: {
    label: 'Divine Restore',
    needsTarget: false,
    special: true,
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
