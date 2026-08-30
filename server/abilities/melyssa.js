import { decayShieldIfDue, isSilenced } from '../engine/damagePipeline.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';

// Reactive shield (see engine/categories/onHitLanded.js): whenever damage
// actually reaches her hearts (ctx.amountDealt - already reduced by
// absorption for a normal hit, or the full raw amount for an ignoresShield
// hit since those skip absorption entirely), she gains new shield EXACTLY
// equal to that leaked-through amount, REPLACING whatever shield she had
// left (not additive). Reuses the same decaying:true persistence Tharox/
// Athena already have (clears only at the start of HER OWN next turn, via
// decayShieldIfDue in this file's onTurnStart). Fires even when amountDealt
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
};

// Shield decay symmetry with Tharox's Glory Smash / Athena's Divine
// Restore - her reactive shield (see damagePipeline.js's applyDamage) uses
// the identical decaying:true mechanic, which only ever clears via this
// same onTurnStart hook already called generically for every character by
// turnEngine.js's beginCharacterTurn.
export function onTurnStart(character, game, log) {
  decayShieldIfDue(character);
}
