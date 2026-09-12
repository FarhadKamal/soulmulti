import { applyDamage, registerRebirth } from '../engine/damagePipeline.js';

// Blood Frenzy: hearts<=3 one-time special (confirmed ruling, 2026-09-12).
// Two effects, one permanent and one immediate:
//   1. Permanently disables Blood Hunt's own streak-reset-on-target-switch
//      rule for the REST OF THE MATCH (bloodFrenzyUnleashed flag, checked
//      inside bloodHunt.execute below) - from this point on, EVERY future
//      Blood Hunt (chosen-target OR this burst's own random hits) just
//      keeps building the same one streakCount forever, regardless of who
//      he actually hits.
//   2. Immediately unleashes a burst of consecutive random strikes against
//      LIVING ENEMIES (never himself, never an ally in a team mode) - each
//      strike is a full, normal Blood Hunt hit in every respect (shield/
//      dodge/untargetable all apply exactly as they would to a normal
//      chosen-target Blood Hunt), just with the target picked at random
//      each time (fully independent per strike - the same enemy CAN be hit
//      more than once in one burst) instead of player-chosen. The streak
//      climbs WITHIN the burst itself, strike by strike, exactly like a
//      real multi-turn streak would (confirmed via example: streak=1
//      walking in -> burst hits deal 2, then 3, then 4) - it's the same
//      running counter as everywhere else, just several hits landing in
//      one action instead of one per turn.
// Strike count scales with TOTAL alive characters (Blade included),
// confirmed ruling: 4 alive -> 5 strikes, 3 alive -> 3 strikes, 2 alive ->
// 2 strikes. Once he's the last two standing, only Blade and one opponent
// can be alive together, so 2-strike is this ability's floor.
const BLOOD_FRENZY_HEARTS_THRESHOLD = 3;
function bloodFrenzyStrikeCount(aliveCount) {
  if (aliveCount >= 4) return 5;
  if (aliveCount === 3) return 3;
  return 2;
}
function livingEnemiesFor(character, game) {
  return Object.values(game.characters).filter(
    (c) => c.id !== character.id && c.ownerId !== character.ownerId && !c.isKO && !c.untargetable
  );
}

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
      // Blood Frenzy (confirmed ruling, 2026-09-12): once unleashed, the
      // streak never resets on a target switch again for the rest of the
      // match - streakTargetId tracking becomes permanently moot from here
      // on, the counter just always increments regardless of who's hit.
      if (character.special.bloodFrenzyUnleashed) {
        character.special.streakCount += 1;
      } else if (character.special.streakTargetId === targetId) {
        character.special.streakCount += 1;
      } else {
        character.special.streakTargetId = targetId;
        character.special.streakCount = 1;
      }
      const amount = character.special.streakCount;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'bloodHunt', targetId, streak: character.special.streakCount, ...result });
      return result;
    },
  },
  bloodFrenzy: {
    label: 'Blood Frenzy',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= BLOOD_FRENZY_HEARTS_THRESHOLD && !character.special.usedBloodFrenzy,
    execute(character, targetId, game, log) {
      character.special.usedBloodFrenzy = true;
      character.special.bloodFrenzyUnleashed = true;
      const aliveCount = Object.values(game.characters).filter((c) => !c.isKO).length;
      const strikeCount = bloodFrenzyStrikeCount(aliveCount);
      const hits = [];
      // Same "first occurrence wins" deferred-field capture as Shadow
      // Army/Earthshatter/Grim Barrage/Mirage Burst - finalizeAction only
      // ever reads these off the top-level return value, never off entries
      // buried inside `hits`.
      let rebirthLogEntry = null;
      let mirrorLogEntry = null;
      let mirrorReflectLogEntry = null;
      let fowlPlayRevertLogEntry = null;
      let divineJudgmentTriggerLogEntry = null;
      let prophecyOfDoomTriggerLogEntry = null;
      for (let i = 0; i < strikeCount; i++) {
        // Re-queries the living pool fresh before EVERY strike (not once up
        // front) - an earlier strike in this same burst can KO someone,
        // shrinking who's left to randomly hit for the remaining strikes.
        const pool = livingEnemiesFor(character, game);
        if (pool.length === 0) break; // everyone's already down - burst ends early
        const target = pool[Math.floor(Math.random() * pool.length)];
        character.special.streakCount += 1;
        const amount = character.special.streakCount;
        const result = applyDamage(game, log, {
          sourceCharacterId: character.id,
          targetCharacterId: target.id,
          amount,
        });
        hits.push({ targetId: target.id, streak: character.special.streakCount, amountDealt: result.amountDealt, dodged: result.dodged, koTriggered: result.koTriggered });
        if (result.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.rebirthLogEntry;
        if (result.mirrorLogEntry && !mirrorLogEntry) mirrorLogEntry = result.mirrorLogEntry;
        if (result.mirrorResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorResult.rebirthLogEntry;
        if (result.mirrorReflectLogEntry && !mirrorReflectLogEntry) mirrorReflectLogEntry = result.mirrorReflectLogEntry;
        if (result.mirrorReflectResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorReflectResult.rebirthLogEntry;
        if (result.fowlPlayRevertLogEntry && !fowlPlayRevertLogEntry) fowlPlayRevertLogEntry = result.fowlPlayRevertLogEntry;
        if (result.divineJudgmentTriggerLogEntry && !divineJudgmentTriggerLogEntry) divineJudgmentTriggerLogEntry = result.divineJudgmentTriggerLogEntry;
        if (result.prophecyOfDoomTriggerLogEntry && !prophecyOfDoomTriggerLogEntry) prophecyOfDoomTriggerLogEntry = result.prophecyOfDoomTriggerLogEntry;
        if (character.isKO) break; // a mirrored/reflected counter-hit KO'd Blade himself mid-burst
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'bloodFrenzy', hits });
      return { hits, rebirthLogEntry, mirrorLogEntry, mirrorReflectLogEntry, fowlPlayRevertLogEntry, divineJudgmentTriggerLogEntry, prophecyOfDoomTriggerLogEntry };
    },
  },
};
