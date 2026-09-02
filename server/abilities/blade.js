import { applyDamage, registerRebirth, resolveMassiveFartRedirect } from '../engine/damagePipeline.js';

// Rebirth: automatic, intercepts the KO the instant it would happen (see
// damagePipeline.js's KO branch, which calls this registered reset instead
// of hand-rolling Blade's own state reset inline). Only his OWN state is
// reset here - every OTHER character's stale reference to him (curse,
// freeze, marks, grudge, poison, headache, mirage stacks, a stale Rewind
// snapshot) is handled generically by onOtherRevived callbacks, one per
// affected character's own ability module (see
// engine/categories/onOtherRevived.js and each of those files' own
// registration).
registerRebirth('blade', (character) => {
  character.hearts = 2;
  character.special.rebirthUsed = true;
  character.usedSpecial = true;
  // Comes back fresh: clear any lingering negative status rather than
  // carrying it over from the moment he died.
  character.skipNextTurn = false;
  character.skipHeadacheTurn = false;
  character.special.streakTargetId = null;
  character.special.streakCount = 0;
});

export const actions = {
  bloodHunt: {
    label: 'Blood Hunt',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // Resolve Boingo's Massive Fart redirect (if active) BEFORE deciding
      // the streak/damage amount - the streak has to track whoever the hit
      // ACTUALLY lands on, not who Blade originally picked (confirmed
      // ruling, 2026-09-02: a redirected hit that lands on a new target
      // starts a fresh streak of 1 against THEM, not against his original
      // choice). Passing the already-resolved target into applyDamage
      // with no further massiveFart involvement needed there - its own
      // redirect check only fires when it hasn't already been resolved
      // upstream, but resolving it twice would double-roll, so this
      // reassigns targetId itself and applyDamage naturally treats it as
      // the real target going forward (still redirect-eligible in
      // principle, but a second reroll would be wrong - see below).
      const actualTargetId = resolveMassiveFartRedirect(game, log, character.id, targetId);
      if (character.special.streakTargetId === actualTargetId) {
        character.special.streakCount += 1;
      } else {
        character.special.streakTargetId = actualTargetId;
        character.special.streakCount = 1;
      }
      const amount = character.special.streakCount;
      // Redirect (if any) already resolved above via resolveMassiveFart
      // Redirect - both flags below must be set together (matching
      // applyDamage's own inline handling) so a redirected hit that lands
      // on an untargetable character still bypasses that too, same as
      // every other Massive Fart-redirected attack. ignoresDodge doubles
      // as the "don't roll a second redirect" guard, since applyDamage's
      // own inline check is gated on !ignoresDodge.
      const massiveFartHandled = !!game.massiveFartActive;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: actualTargetId,
        amount,
        ignoresDodge: massiveFartHandled,
        ignoresUntargetable: massiveFartHandled,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'bloodHunt', targetId: actualTargetId, streak: character.special.streakCount, ...result });
      return result;
    },
  },
};
