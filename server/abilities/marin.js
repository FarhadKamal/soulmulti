import { applyDamage, applyHeal } from '../engine/damagePipeline.js';

// The full discoverable spell pool - Arcane Study draws one of whichever
// aren't in special.discoveredSpells yet, so each ever appears at most once
// per match. Same mechanic as Rowan's own ALL_SPELL_IDS, different pool -
// unlike his kit (situational tools cast on demand), every one of these 5
// auto-activates the instant it's discovered, via onTurnStart below - none
// of them appear as a separate castable action in the exports.actions map.
const ALL_SPELL_IDS = ['everbloom', 'threefoldVeil', 'cleanSlate', 'piercingWand', 'wandMastery'];

function pickUndiscoveredSpell(character) {
  const remaining = ALL_SPELL_IDS.filter((id) => !character.special.discoveredSpells.has(id));
  if (remaining.length === 0) return null;
  return remaining[Math.floor(Math.random() * remaining.length)];
}

// Fires once at the start of Marin's own turn (turnEngine.js's
// beginCharacterTurn, gated by game.turnStartFiredFor). Resolves the
// one-turn-delayed Arcane Study reveal, clears its cooldown (same shape as
// Rowan's own onTurnStart), auto-activates whichever passive was just
// revealed, and runs Everbloom's own recurring heal + Clean Slate's
// immunity countdown.
export function onTurnStart(character, game, log) {
  if (character.special.arcaneStudyPending) {
    const spellId = pickUndiscoveredSpell(character);
    character.special.arcaneStudyPending = false;
    if (spellId) {
      character.special.discoveredSpells.add(spellId);
      log.push({ type: 'spell-discovered', characterId: character.id, spellId });
      // Every spell auto-activates the instant it's revealed - no separate
      // cast action exists for any of them, unlike Rowan's kit.
      if (spellId === 'everbloom') character.special.everbloomActive = true;
      else if (spellId === 'threefoldVeil') character.special.veilChargesRemaining = 3;
      else if (spellId === 'cleanSlate') character.special.cleanSlateArmed = true;
      else if (spellId === 'piercingWand') character.special.piercingWandActive = true;
      else if (spellId === 'wandMastery') character.special.wandMasteryActive = true;
    }
  }
  if (character.special.arcaneStudyOnCooldown) {
    character.special.arcaneStudyOnCooldown = false;
  }
  // Everbloom: +1 heart every OTHER one of her own turns, forever, once
  // discovered - heals on turn 1, 3, 5... since discovery, skips 2, 4, 6...
  // Balance-tuned down from healing every single turn (unlimited sustain
  // with zero downside felt too strong - see soulclash_marin_design memory)
  // to half that rate while staying permanent, rather than a hard cutoff
  // after N turns. everbloomTurnCount increments on every one of her own
  // turns while active (whether or not this particular one heals), so the
  // skip pattern is exact regardless of how many turns pass.
  if (character.special.everbloomActive && !character.isKO) {
    character.special.everbloomTurnCount += 1;
    const shouldHealThisTurn = character.special.everbloomTurnCount % 2 === 1;
    if (shouldHealThisTurn) {
      // isFirstTick: true only for the very first heal (the same turn it
      // was discovered) - client-side (main.js) uses this to play her
      // spoken voice line just once, not on every recurring tick for the
      // rest of the match, while the short sound effect itself still plays
      // every time it actually heals.
      const isFirstTick = !character.special.everbloomFirstTickDone;
      const healed = applyHeal(game, character.id, 1);
      if (healed > 0) {
        character.special.everbloomFirstTickDone = true;
        log.push({ type: 'everbloom-tick', characterId: character.id, healed, isFirstTick });
      }
    }
  }
  // Clean Slate's immunity window counts down on HER OWN turns once it's
  // actually fired (cleanSlateArmed already false by then) - same
  // self-targeted countdown shape as Everbloom above, not a cross-character
  // scan like Rowan's silence tick since only she can ever be the target.
  if (character.special.cleanSlateImmuneTurnsRemaining > 0) {
    character.special.cleanSlateImmuneTurnsRemaining -= 1;
    if (character.special.cleanSlateImmuneTurnsRemaining === 0) {
      log.push({ type: 'clean-slate-immunity-end', characterId: character.id });
    }
  }
}

export const actions = {
  wandStrike: {
    label: 'Wand Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // Piercing Wand / Wand Mastery fold silently into every future cast
      // once discovered - no separate action, no visual change to which
      // button is pressed, confirmed stacking (both apply together).
      const amount = character.special.wandMasteryActive ? 2 : 1;
      const ignoresShield = !!character.special.piercingWandActive;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id, targetCharacterId: targetId, amount, ignoresShield,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'wandStrike', targetId, ...result });
      return result;
    },
  },
  arcaneStudy: {
    label: 'Arcane Study',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.special.arcaneStudyOnCooldown
      && character.special.discoveredSpells.size < ALL_SPELL_IDS.length,
    execute(character, targetId, game, log) {
      character.special.arcaneStudyPending = true;
      character.special.arcaneStudyOnCooldown = true;
      log.push({ type: 'setup', characterId: character.id, actionId: 'arcaneStudy' });
      return {};
    },
  },
};
