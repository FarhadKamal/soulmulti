import { applyDamage } from '../engine/damagePipeline.js';

const DAMAGE_BY_CHARGE = [1, 2, 3];

export const actions = {
  chargeUp: {
    label: 'Charge Up',
    needsTarget: false,
    isLegal: (character) => character.special.chargeCount < 2,
    execute(character, targetId, game, log) {
      character.special.chargeCount += 1;
      log.push({ type: 'setup', characterId: character.id, actionId: 'chargeUp', chargeCount: character.special.chargeCount });
      return {};
    },
  },
  thunderWrath: {
    label: 'Thunder Wrath',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const amount = DAMAGE_BY_CHARGE[character.special.chargeCount];
      character.special.chargeCount = 0;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'thunderWrath', targetId, amount, ...result });
      return result;
    },
  },
  soulSwap: {
    label: 'Soul Swap',
    needsTarget: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      const target = game.characters[targetId];
      const tmp = character.hearts;
      character.hearts = target.hearts;
      target.hearts = tmp;
      log.push({ type: 'special', characterId: character.id, actionId: 'soulSwap', targetId });
      return { swapped: true };
    },
  },
  // Follow-up Thunder Wrath fired for free immediately after Soul Swap.
  // hidden: true keeps it out of getLegalActions - it's never a player-picked
  // button, only ever armed programmatically right after soulSwap resolves.
  soulSwapWrath: {
    label: 'Thunder Wrath (free, from Soul Swap)',
    needsTarget: true,
    hidden: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      return actions.thunderWrath.execute(character, targetId, game, log);
    },
  },
};
