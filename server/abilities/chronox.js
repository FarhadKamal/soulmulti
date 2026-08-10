import { applyDamage } from '../engine/damagePipeline.js';
import { flipCoin } from '../engine/random.js';
import { isTutorialMode } from '../engine/state.js';

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
    execute(character, targetId, game, log, extra) {
      // Tutorial mode forces a deterministic outcome (the bot always deals
      // flat 1; the human's own scripted sequence forces specific
      // heads/tails per step) instead of the real coin flip - see
      // server/data/tutorialSequences.js and its forcedAmount field. Every
      // non-tutorial call passes no `extra`, leaving the normal random
      // roll completely untouched.
      const flip = isTutorialMode(game) && extra?.forcedAmount != null
        ? (extra.forcedAmount === 2 ? 'heads' : 'tails')
        : flipCoin();
      const isTutorialForced = isTutorialMode(game) && extra?.forcedAmount != null;
      const amount = isTutorialForced ? extra.forcedAmount : (flip === 'heads' ? 2 : 1);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
        // Tutorial-forced hits ignore shield in both directions (this
        // character's own attack forced by the tutorial, OR the tutorial
        // bot's forced attack when it's playing Chronox) - a shielded
        // target (either side's own Chrono Guard, if THEY'RE the one
        // playing Chronox) would otherwise silently discount the forced
        // amount and break the tutorial's exact heart math. Non-tutorial
        // calls are unaffected.
        ignoresShield: isTutorialForced,
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
