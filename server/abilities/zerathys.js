import { applyDamage } from '../engine/damagePipeline.js';
import { makeSetupAction } from '../engine/categories/neutralAction.js';

const DAMAGE_BY_CHARGE = [1, 2, 3];
const OVERCHARGE_COLLAPSE_THRESHOLD = 3;
const OVERCHARGE_COLLAPSE_DAMAGE = 3;

// Overcharge Collapse: pure Passive Action (#23), no button, no cast, no
// flag - confirmed ruling (2026-09-02): "its just a passive. you don't
// even need to create extra button name for it". Continuously LIVE-gated
// on his CURRENT hearts, re-evaluated every time this is checked (not a
// one-time trigger, not permanent once hit) - drops back off the instant
// he's healed above the threshold (e.g. a lucky Soul Swap), and can
// re-activate again later from any subsequent damage, any number of
// times in a match. While active: Charge Up disappears from his legal
// actions entirely, and Thunder Wrath always deals a flat
// OVERCHARGE_COLLAPSE_DAMAGE regardless of chargeCount. chargeCount
// itself is treated as irrelevant (not read) while active, and is reset
// to 0 the next time chargeUp/thunderWrath actually runs while active -
// confirmed ruling: nothing carries over once he's healed back above the
// threshold, he starts fresh needing to Charge Up from 0 again.
function isOverchargeCollapseActive(character) {
  return character.hearts <= OVERCHARGE_COLLAPSE_THRESHOLD;
}

// Shared damage logic for both a normal Thunder Wrath cast and Soul Swap's
// free follow-up - takes actionId explicitly so each caller's own log
// entry is tagged correctly. Confirmed bug, 2026-09-04: soulSwapWrath used
// to just call actions.thunderWrath.execute() directly, which hardcoded
// actionId: 'thunderWrath' into its own log.push - so the free follow-up's
// log line was indistinguishable from a normal turn's Thunder Wrath cast,
// and the client's ACTION_LABELS['soulSwapWrath'] = 'Thunder Wrath (free)'
// entry was dead code, never actually reached.
function executeThunderWrath(character, targetId, game, log, actionId) {
  const overcharged = isOverchargeCollapseActive(character);
  const amount = overcharged ? OVERCHARGE_COLLAPSE_DAMAGE : DAMAGE_BY_CHARGE[character.special.chargeCount];
  character.special.chargeCount = 0;
  const result = applyDamage(game, log, {
    sourceCharacterId: character.id,
    targetCharacterId: targetId,
    amount,
  });
  log.push({ type: 'attack', characterId: character.id, actionId, targetId, amount, overcharged, ...result });
  return result;
}

export const actions = {
  // Neutral Action (see engine/categories/neutralAction.js): increments a
  // bounded counter (cap enforced by isLegal), feeding thunderWrath's
  // damage tier below. thunderWrath is ALWAYS legal and resets the counter
  // regardless of whether it was ever incremented, so a 0-charge cast still
  // deals DAMAGE_BY_CHARGE[0]. Hidden entirely while Overcharge Collapse
  // (Passive Action #23, see above) is active - there is no point banking
  // charge that Thunder Wrath won't even read while he's this low.
  chargeUp: makeSetupAction({
    label: 'Charge Up',
    actionId: 'chargeUp',
    isLegal: (character) => !isOverchargeCollapseActive(character) && character.special.chargeCount < 2,
    mutate(character) {
      character.special.chargeCount += 1;
    },
    extraLogFields: (character) => ({ chargeCount: character.special.chargeCount }),
  }),
  thunderWrath: {
    label: 'Thunder Wrath',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      return executeThunderWrath(character, targetId, game, log, 'thunderWrath');
    },
  },
  soulSwap: {
    label: 'Soul Swap',
    needsTarget: true,
    special: true,
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
      return executeThunderWrath(character, targetId, game, log, 'soulSwapWrath');
    },
  },
};
