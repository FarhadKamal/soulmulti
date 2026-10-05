import { applyDamage, applyShield, clampLockedHearts } from '../engine/damagePipeline.js';
import { makeSetupAction } from '../engine/categories/neutralAction.js';

const DAMAGE_BY_CHARGE = [1, 2, 3];
const SOUL_STORM_HEARTS_THRESHOLD = 3;

// Everyone Soul Storm reaches: living, not a transformed Beast Form Grimtal,
// not either deep-sea sealed party (same exclusions as Marin's Lifebond).
export function soulStormParticipants(game) {
  return Object.values(game.characters).filter(
    (c) => !c.isKO && !(c.id === 'grimtal' && c.special?.beastFormActive) && !c.deepSeaSealed
  );
}

// A random derangement of slot indices (nobody keeps their own slot), so
// order[i] is whose hearts slot i receives. Prefers - among a handful of
// random derangements - one where every character's hearts NUMBER actually
// changes too; when that's impossible (e.g. two characters share a value
// that has nowhere else to go) any derangement is accepted.
function pickSoulStormPermutation(values) {
  const n = values.length;
  const randomDerangement = () => {
    for (;;) {
      const p = [...Array(n).keys()];
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      if (p.every((v, i) => v !== i)) return p;
    }
  };
  let fallback = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const p = randomDerangement();
    if (!fallback) fallback = p;
    if (p.every((src, i) => values[src] !== values[i])) return p;
  }
  return fallback;
}
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
  // Overcharge Collapse's own shield stake (confirmed ruling, 2026-09-11):
  // every Thunder Wrath cast while overcharged - the normal action AND
  // Soul Swap's free follow-up, both routing through this shared function -
  // grants him +1 shield, regardless of whether the hit actually dealt
  // damage ("every cast while overcharged, regardless of whether it
  // actually dealt damage"). No cap, stacks with every qualifying cast
  // ("say he hit total 2 hit .. then shield will be 2"). Not decaying -
  // behaves exactly like any other normal shield once granted, sticking
  // around until a real hit consumes it, completely independent of whether
  // Overcharge Collapse is still active by the time that happens (confirmed
  // ruling: healing back above the threshold does NOT strip it away).
  if (overcharged) {
    applyShield(game, character.id, 1);
  }
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
      // Akyros's Shadow Seal - this directly assigns hearts outside
      // applyDamage/applyHeal, so lockedHearts on EITHER side of the swap
      // could now exceed the new hearts value (confirmed reachable bug,
      // 2026-09-20 - see clampLockedHearts's own comment for the full
      // reasoning). Clamp both unconditionally; a no-op for anyone not
      // currently sealed (lockedHearts is 0 by default).
      clampLockedHearts(character);
      clampLockedHearts(target);
      log.push({ type: 'special', characterId: character.id, actionId: 'soulSwap', targetId });
      return { swapped: true };
    },
  },
  // Soul Storm (design-locked 2026-10-05): hearts<=3 one-time special - a
  // board-wide Soul Swap. Every eligible living character's hearts are
  // shuffled among them so that NOBODY keeps their own slot (confirmed
  // ruling: "everyone must change" - when two characters happen to hold the
  // same hearts value, that number can still come back, but never from
  // their own slot). Zerathys himself is part of the shuffle with no
  // guarantee of landing high. No free Thunder Wrath afterward (confirmed
  // ruling). Like Lifebond, this sets hearts directly (not a hit or a
  // heal - no shield/dodge interaction) and excludes a transformed Beast
  // Form Grimtal and both deep-sea sealed parties (confirmed ruling). Chronox
  // can Rewind it if it changed his hearts (see turnEngine.js's
  // soulStormMayTargetChronox).
  soulStorm: {
    label: 'Soul Storm',
    needsTarget: false,
    special: true,
    isLegal: (character, game) => character.hearts <= SOUL_STORM_HEARTS_THRESHOLD
      && !character.special.usedSoulStorm
      && soulStormParticipants(game).length >= 2
      && soulStormParticipants(game).some((c) => c.id === character.id),
    execute(character, targetId, game, log) {
      character.special.usedSoulStorm = true;
      const living = soulStormParticipants(game);
      const before = living.map((c) => c.hearts);
      const order = pickSoulStormPermutation(before);
      const changes = living.map((c, i) => ({ characterId: c.id, before: before[i], after: before[order[i]] }));
      living.forEach((c, i) => {
        c.hearts = before[order[i]];
        // Sets hearts directly outside applyDamage/applyHeal - same
        // Shadow Seal clamp Soul Swap/Lifebond need (see
        // clampLockedHearts's own comment).
        clampLockedHearts(c);
      });
      log.push({ type: 'special', characterId: character.id, actionId: 'soulStorm', changes });
      return { changes };
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
