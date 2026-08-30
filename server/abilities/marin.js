import { applyDamage, applyHeal, hasNegativeStatus, clearNegativeStatuses, heartsSnapshot } from '../engine/damagePipeline.js';
import { registerDodgeDefense } from '../engine/categories/dodgeDefenseRegistry.js';
import { makeDiscoveryKit } from '../engine/categories/discoveryKit.js';

// The full discoverable spell pool - Arcane Study draws one of whichever
// aren't in special.discoveredSpells yet, so each ever appears at most once
// per match. Same mechanic as Rowan's own ALL_SPELL_IDS, different pool -
// unlike his kit (situational tools cast on demand), every one of these 5
// auto-activates the instant it's discovered, via the onDiscover hook below
// - none of them appear as a separate castable action in the exports.actions
// map.
const ALL_SPELL_IDS = ['everbloom', 'threefoldVeil', 'cleanSlate', 'piercingWand', 'wandMastery'];

const discoveryKit = makeDiscoveryKit({
  spellIds: ALL_SPELL_IDS,
  onDiscover(character, game, log, spellId) {
    if (spellId === 'everbloom') character.special.everbloomActive = true;
    else if (spellId === 'threefoldVeil') character.special.veilChargesRemaining = 3;
    else if (spellId === 'cleanSlate') {
      // Confirmed bug fix: Clean Slate's reactive trigger only ever caught
      // a NEW status attempt going forward - it never checked whether she
      // was already carrying one of the 4 covered statuses from BEFORE this
      // exact discovery moment. If she is, cleanse it immediately right
      // here and go straight to the immunity window (same as a real
      // trigger) instead of leaving cleanSlateArmed true and waiting for a
      // future attempt that may never come - a stale curse/freeze/mark/
      // silence from turns ago would otherwise sit there completely
      // invisible to Clean Slate forever.
      if (hasNegativeStatus(character, game)) {
        clearNegativeStatuses(character, game, log);
        character.special.cleanSlateImmuneTurnsRemaining = 3;
        log.push({ type: 'clean-slate-trigger', characterId: character.id, hearts: heartsSnapshot(game) });
        return { immunityJustStarted: true };
      }
      character.special.cleanSlateArmed = true;
    } else if (spellId === 'piercingWand') character.special.piercingWandActive = true;
    else if (spellId === 'wandMastery') character.special.wandMasteryActive = true;
  },
});

// Dodge Defense category registration (see
// engine/categories/dodgeDefense.js) - additive, not yet consumed by
// applyDamage's own inline dodge block. Threefold Veil: a flat shared pool
// of charges against ANY hit from anyone, unlike Akyros's per-attacker
// tracking - every consecutive hit consumes the pool until spent, no
// recharge.
registerDodgeDefense('marin', {
  canDodge(target) {
    return target.special.veilChargesRemaining > 0;
  },
  consume(target) {
    target.special.veilChargesRemaining -= 1;
  },
});

// Fires once at the start of Marin's own turn (turnEngine.js's
// beginCharacterTurn, gated by game.turnStartFiredFor). Resolves the
// one-turn-delayed Arcane Study reveal, clears its cooldown (same shape as
// Rowan's own onTurnStart), auto-activates whichever passive was just
// revealed, and runs Everbloom's own recurring heal + Clean Slate's
// immunity countdown.
export function onTurnStart(character, game, log) {
  // immunityJustStartedThisCall: true if Clean Slate's discovery-time
  // retroactive cleanse just started the immunity window THIS SAME call
  // (see discoveryKit.js's onDiscover return-value contract) - the
  // countdown block further down runs unconditionally every onTurnStart,
  // so without this guard a freshly-set 3-turn window would immediately
  // get decremented to 2 in the same call it was set, one turn short of
  // every other trigger path (a real status-cast-triggered cleanse starts
  // on Marin's turn BEFORE the window counts down, since that trigger
  // fires from inside a DIFFERENT character's own turn, not hers).
  const discoverResult = discoveryKit.resolveOnTurnStart(character, game, log);
  const immunityJustStartedThisCall = discoverResult?.immunityJustStarted === true;
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
        log.push({ type: 'everbloom-tick', characterId: character.id, healed, isFirstTick, hearts: heartsSnapshot(game) });
      }
    }
  }
  // Clean Slate's immunity window counts down on HER OWN turns once it's
  // actually fired (cleanSlateArmed already false by then) - same
  // self-targeted countdown shape as Everbloom above, not a cross-character
  // scan like Rowan's silence tick since only she can ever be the target.
  if (character.special.cleanSlateImmuneTurnsRemaining > 0 && !immunityJustStartedThisCall) {
    character.special.cleanSlateImmuneTurnsRemaining -= 1;
    if (character.special.cleanSlateImmuneTurnsRemaining === 0) {
      log.push({ type: 'clean-slate-immunity-end', characterId: character.id, hearts: heartsSnapshot(game) });
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
  arcaneStudy: discoveryKit.arcaneStudy,
};
