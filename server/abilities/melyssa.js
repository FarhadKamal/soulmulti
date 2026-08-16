import { decayShieldIfDue } from '../engine/damagePipeline.js';

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
