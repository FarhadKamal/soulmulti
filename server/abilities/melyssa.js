import { isSilenced } from '../engine/damagePipeline.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';

// Full Control's hearts<=3 gate (also drives the guaranteed-Mind-Control
// passive below - both use this same threshold, confirmed ruling: "when
// her health will be <=3").
const FULL_CONTROL_HEARTS_THRESHOLD = 3;

// Passive (no button, always-on once hearts<=3): Mind Control's normal 50%
// resist chance (turnEngine.js's executeActionAsPuppet) is removed
// entirely - every puppeted action succeeds. Exported so
// executeActionAsPuppet can check it without a circular import (melyssa.js
// already sits below turnEngine.js in the dependency direction - ability
// files import FROM the engine, never the reverse).
export function hasGuaranteedMindControl(character) {
  return !!character && character.hearts <= FULL_CONTROL_HEARTS_THRESHOLD;
}

// Reactive shield (see engine/categories/onHitLanded.js): whenever damage
// actually reaches her hearts (ctx.amountDealt - already reduced by
// absorption for a normal hit, or the full raw amount for an ignoresShield
// hit since those skip absorption entirely), she gains new shield EXACTLY
// equal to that leaked-through amount, REPLACING whatever shield she had
// left (not additive). Reuses the same decaying:true persistence Tharox/
// Athena already have (clears via decayAllDueShields, run at the very start
// of beginCharacterTurn - BEFORE this turn's own poison tick, so a shield
// granted by a poison tick landing on her own turn survives instead of
// being wiped moments later). Fires even when amountDealt
// is 0 (a fully-absorbed hit) - REPLACE semantics mean a stale leftover
// shield must be explicitly zeroed that turn too, not just left alone.
// No isMirror/isPoisonTick exclusion (unlike Kaelis's grudge) - matches the
// original inline block's own gating, which was purely `!target.isKO`.
// That guard is checked HERE now (isKO explicitly), rather than at the
// dispatcher's own call site in applyDamage - the shared onHitLanded
// dispatch point is no longer blanket-gated on `!isKO` for every
// registrant, since Athena's curse-mirror specifically needs to still fire
// on the exact hit that KOs her (see athena.js) - each callback that cares
// about isKO now checks it itself.
registerOnHitLanded('melyssa', (character, game, log, ctx) => {
  if (character.isKO) return;
  // Boingo's Fowl Play - confirmed ruling: "NO SHIELD... during chicken
  // status" extends to shield GENERATION too, not just shield blocking
  // damage - a chickenified Melyssa must not gain any reactive shield at
  // all (confirmed bug, 2026-09-04, live report: a match log showed
  // "Melyssa:2+1sh" while she was still a chicken). applyDamage's own
  // target.isChicken bypass already makes any shield she'd have pointless
  // against a FUTURE chicken attack, but this passive fires unconditionally
  // regardless of what hit her, so it needs its own explicit guard rather
  // than relying on that downstream bypass alone.
  if (character.isChicken) return;
  // Rowan's Silence Lock suppresses every shield source while active -
  // including this reactive one, so a silenced Melyssa gets 0 here instead
  // of the normal leaked-damage amount.
  character.shield = isSilenced(character, game) ? 0 : ctx.amountDealt;
  character.shieldDecaying = true;
});

// Melyssa has no personal attack kit at all - her one action, Mind Control,
// only SELECTS a puppet target here (sets character.special.controlling so
// the client shows her held "mind_control_selection.jpg" portrait for the
// rest of the sequence). The actual puppeted action executes via a
// SEPARATE executeAction(game, puppetId, ...) call from server/index.js's
// stage-2 handler (handleMindControlAction) - mirrors Soul Swap's split
// between this module's own execute() and index.js's handleSoulSwapWrath,
// except melyssa.js owns even less of the total mechanic than zerathys.js
// owns of Soul Swap (Zerathys's own module resolves the actual heart-swap;
// this module resolves nothing but bookkeeping/logging).
export const actions = {
  mindControl: {
    label: 'Mind Control',
    needsTarget: true, // target = the puppet, NOT the puppet's eventual victim
    special: true,
    isLegal: () => true, // unlimited, no cooldown, no usedSpecial gate
    execute(character, targetId, game, log) {
      character.special.controlling = true;
      // Real serialized state (survives sanitizeGameForBroadcast untouched,
      // same as every other plain .special field) so clients can identify
      // WHO the current puppet is for the whole sequence, not just at the
      // selection instant - room.melyssaControl (server/index.js) covers
      // the same window server-side, but was never broadcast past the
      // initial awaitingMindControlAction moment. Cleared in
      // finishMelyssaTurn alongside controlling.
      character.special.puppetCharacterId = targetId;
      log.push({ type: 'mind-control-select', characterId: character.id, targetId });
      return { puppetCharacterId: targetId };
    },
  },
  // Full Control: one-time hearts<=3 special (confirmed ruling: "when her
  // health will be <=3"). Every other living character (minus a
  // Clean-Slate-protected Marin) becomes a puppet simultaneously, randomly
  // paired up, and each fires their own real normal-tier attack at their
  // assigned puppet with full pure damage - no dodge, shield, untargetable,
  // immortal, or Rebirth. This function only does the cast-time bookkeeping
  // (usedFullControl flag, its own log entry) - the actual multi-hero burst
  // (derangement, per-hero action dispatch, defense bypass) is resolved by
  // turnEngine.js's resolveFullControl, called from executeAction right
  // after this execute() returns (see that file's own comment for why the
  // split is necessary - melyssa.js can't import ABILITY_MODULES without a
  // circular import). needsTarget: false - there's no player-chosen target
  // at all, every pairing is decided randomly server-side.
  fullControl: {
    label: 'Full Control',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= FULL_CONTROL_HEARTS_THRESHOLD && !character.special.usedFullControl,
    execute(character, targetId, game, log) {
      character.special.usedFullControl = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'fullControl' });
      return {};
    },
  },
};
