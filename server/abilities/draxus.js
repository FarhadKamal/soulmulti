import { applyDamage } from '../engine/damagePipeline.js';

const DYING_BLOW_TIERS = [
  { min: 6, amount: 1 },
  { min: 4, amount: 2 },
  { min: 1, amount: 3 },
];

function dyingBlowAmount(hearts) {
  const tier = DYING_BLOW_TIERS.find((t) => hearts >= t.min);
  return tier ? tier.amount : 1;
}

// Fires exactly once at the start of his own turn (gated by
// game.turnStartFiredFor in gameFlow.js's getActingCharacterId, so this
// never re-fires mid-way through his own 3-strike bonus turn). This is
// where the death-proof window ends and, if it was active, the bonus turn
// is granted. If Deathless Fury was never cast (or already consumed), this
// is a no-op every other turn.
export function onTurnStart(character, game, log) {
  if (character.special.deathproofActive) {
    character.special.deathproofActive = false;
    character.special.bonusActionsRemaining = 3;
    log.push({ type: 'deathless-fury-end', characterId: character.id });
  }
}

export const actions = {
  dyingBlow: {
    label: 'Dying Blow',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // Captured BEFORE index.js's post-action bonusActionsRemaining
      // decrement runs - true for all 3 of his bonus-turn strikes, false
      // for a completely normal turn. strikeNumber (1-based) lets the
      // client play the right One/Two/Three voice line and immortal_strike
      // flash - 3 remaining -> strike 1, 2 remaining -> strike 2, 1
      // remaining -> strike 3.
      const isBonusStrike = character.special.bonusActionsRemaining > 0;
      const strikeNumber = isBonusStrike ? 4 - character.special.bonusActionsRemaining : null;
      const amount = dyingBlowAmount(character.hearts);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'dyingBlow', targetId, isBonusStrike, strikeNumber, ...result });
      return result;
    },
  },
  deathlessFury: {
    label: 'Deathless Fury',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      character.special.deathproofActive = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'deathlessFury' });
      return {};
    },
  },
};
