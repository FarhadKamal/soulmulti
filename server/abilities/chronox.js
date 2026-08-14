import { applyDamage } from '../engine/damagePipeline.js';
import { flipCoin } from '../engine/random.js';

export function onTurnStart(character, game, log) {
  // Chrono Guard: shield RESETS to exactly 1 each turn - does not stack.
  character.shield = 1;
  log.push({ type: 'passive', characterId: character.id, text: `${character.id}'s shield resets to 1 (Chrono Guard)` });

  // Time Freeze: flat 2-round duration, no coin flip. Casting already skips
  // the target's next turn (round 1); this extends it for 1 more round,
  // then ends automatically.
  if (character.special.freezeActive) {
    const frozenId = character.special.freezeTargetId;
    if (character.special.freezeSkipsApplied < 2) {
      const frozen = game.characters[frozenId];
      if (frozen && !frozen.isKO) frozen.skipNextTurn = true;
      character.special.freezeSkipsApplied += 1;
      log.push({ type: 'freeze-continue', targetCharacterId: frozenId });
    } else {
      character.special.freezeActive = false;
      character.special.freezeTargetId = null;
      log.push({ type: 'freeze-end', targetCharacterId: frozenId });
    }
  }
}

export const actions = {
  cyclonePunch: {
    label: 'Cyclone Punch',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const flip = flipCoin();
      const amount = flip === 'heads' ? 2 : 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'cyclonePunch', targetId, flip, ...result });
      return result;
    },
  },
  timeFreeze: {
    label: 'Time Freeze',
    needsTarget: true,
    special: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      character.special.freezeActive = true;
      character.special.freezeTargetId = targetId;
      character.special.freezeSkipsApplied = 1;
      const target = game.characters[targetId];
      if (target) target.skipNextTurn = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId });
      return { targetCharacterId: targetId };
    },
  },
};
