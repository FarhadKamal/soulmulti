import { applyDamage, isSilenced, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { flipCoin } from '../engine/random.js';

export function onTurnStart(character, game, log) {
  // Chrono Guard: shield RESETS to exactly 1 each turn - does not stack.
  // Rowan's Silence Lock suppresses this entirely while active (blocks
  // every shield source, not just special abilities) - a silenced Chronox
  // gets 0 here instead of the usual reset-to-1.
  if (isSilenced(character, game)) {
    character.shield = 0;
  } else {
    character.shield = 1;
    log.push({ type: 'passive', characterId: character.id, text: `${character.id}'s shield resets to 1 (Chrono Guard)` });
  }

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
      character.special.hasActedOnce = true;
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
    // Not available on his very first turn - user-requested delay so he
    // can't open the match with an immediate freeze before anyone else has
    // even had a turn. Same hasActedOnce pattern as Velorya's Moonstep.
    isLegal: (character) => !character.usedSpecial && character.special.hasActedOnce,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      character.special.hasActedOnce = true;
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the freeze itself - the cast
      // still spends his special, it just never actually freezes her.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId, blocked: true });
        return { targetCharacterId: targetId };
      }
      // Illyra's passive: a 50% chance the freeze itself simply doesn't
      // take - the cast still spends his special either way, same
      // reasoning as the Clean Slate case above.
      if (tryIllyraDodgeStatus(target, game, log, character.id)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId, blocked: true });
        return { targetCharacterId: targetId };
      }
      character.special.freezeActive = true;
      character.special.freezeTargetId = targetId;
      character.special.freezeSkipsApplied = 1;
      if (target) target.skipNextTurn = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId });
      return { targetCharacterId: targetId };
    },
  },
};
