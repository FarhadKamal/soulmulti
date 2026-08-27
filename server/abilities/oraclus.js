import { applyDamage } from '../engine/damagePipeline.js';

export const actions = {
  runeStrike: {
    label: 'Rune Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // Base 1 damage + a permanent, non-decaying +1 per correct Rune
      // Vision prediction (max +2, once both wins are banked) - confirmed
      // ruling. This is the whole reason his base damage stays deliberately
      // low: the growth is meant to come from successfully predicting, not
      // from the basic attack alone.
      const amount = 1 + character.special.runeStrikeBonusDamage;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'runeStrike', targetId, amount, ...result });
      return result;
    },
  },
  // Stage 1 of Rune Vision: pick the predicted ATTACKER. needsTarget: true
  // here means the CLIENT'S normal single-target picker is reused for this
  // first pick (targetId carries the predicted attacker's id) - stage 2
  // (picking the predicted TARGET) is a distinct follow-up decision
  // resolved server-side in index.js, same two-stage pattern as Soul
  // Swap's free Thunder Wrath follow-up (see zerathys.js/index.js's
  // awaitingSoulSwapWrath handling).
  //
  // Legal only while 3-4 total characters (including Oraclus himself) are
  // alive (confirmed ruling - too easy to guess correctly in a straight
  // 1v1/1v2), and only while he hasn't already banked 2 wins (the ability
  // permanently retires after that - confirmed ruling). Unlimited casts
  // otherwise - no usedSpecial gate, no cooldown; a wrong guess costs
  // nothing but the turn spent on it.
  runeVision: {
    label: 'Rune Vision',
    needsTarget: true,
    special: true,
    isLegal: (character, game) => {
      if (character.special.predictionWins >= 2) return false;
      const livingCount = Object.values(game.characters).filter((c) => !c.isKO).length;
      return livingCount === 3 || livingCount === 4;
    },
    execute(character, targetId, game, log) {
      // Stores the predicted attacker only - stage 2 (picking the
      // predicted target) fills in predictedTargetId separately, once the
      // human/bot has made that second choice (see index.js's
      // handleRuneVisionTargetPick / botPlayer.js's equivalent). This
      // execute() call is ONLY reached for stage 1; index.js intercepts
      // the actionId before ever calling executeAction a second time for
      // stage 2, writing predictedTargetId directly instead - there is no
      // second "runeVisionTarget" action definition needed here, unlike
      // Soul Swap's soulSwapWrath, because stage 2 never deals damage or
      // needs its own isLegal/execute pass through the normal ability
      // pipeline.
      character.special.predictedAttackerId = targetId;
      character.special.predictedTargetId = null;
      log.push({ type: 'special', characterId: character.id, actionId: 'runeVision', predictedAttackerId: targetId, stage: 1 });
      return { awaitingTargetPick: true };
    },
  },
};
