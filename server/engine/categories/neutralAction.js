// Factory for the "Neutral Action" category (see the taxonomy in project
// memory: soulclash_mechanic_taxonomy.md #26) - an action that costs a turn
// but has no immediate combat effect, only setting up state for a later
// payoff. Unlike Dodge Defense (slice 1), this is action-DEFINITION
// duplication, not applyDamage-dispatch duplication - each of the 3 current
// setup moves (Tharox's Titan Toss, Zerathys's Charge Up, Grimtal's Claim
// the Kill) is still its own entry in its own module's `actions` export,
// just built by this shared factory instead of hand-typed per file. No
// generic dispatcher/registry needed here, unlike dodgeDefense.js - the
// factory's OUTPUT is a normal action definition consumed exactly the way
// getLegalActions/executeAction already consume every other action.
//
// The 3 existing setup moves share an identical outer shell (needsTarget:
// false, no special:true flag, execute() never calls applyDamage/applyHeal/
// applyShield, log.push({type:'setup',...}), return {}) but differ in
// mutation semantics - `mutate` is the one piece each call site supplies:
//   - Tharox: sets a boolean flag (mutual-exclusion toggle with a payoff
//     move that consumes it).
//   - Zerathys: increments a bounded counter (cap enforced by `isLegal`,
//     feeds a tiered damage array in an ALWAYS-legal payoff move that reads
//     and resets the counter regardless of whether it was ever incremented).
//   - Grimtal: transfers between two counters, externally driven (populated
//     by OTHER characters' KO events elsewhere, not self-initiated).
// `extraLogFields` covers Zerathys's one divergence from the other two -
// his log entry additionally reports the post-increment chargeCount.
export function makeSetupAction({ label, isLegal, mutate, extraLogFields, actionId }) {
  return {
    label,
    needsTarget: false,
    isLegal,
    execute(character, targetId, game, log) {
      mutate(character, game);
      const extra = extraLogFields ? extraLogFields(character, game) : {};
      log.push({ type: 'setup', characterId: character.id, actionId, ...extra });
      return {};
    },
  };
}
