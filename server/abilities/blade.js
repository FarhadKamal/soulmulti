import { applyDamage, registerRebirth } from '../engine/damagePipeline.js';

// Blood Hunt's per-target hit counter (confirmed redesign, 2026-09-14 -
// see state.js's own hitCountByTarget comment for the full "why"). Cycles
// 1->2->3->1->2->3... independently per target character id. Shared by
// both bloodHunt.execute (a single chosen-target hit) and bloodFrenzy's
// own burst (each randomly-targeted strike advances THAT target's own
// counter, same rule, no separate math).
function nextBladeHitCount(character, targetId) {
  const current = character.special.hitCountByTarget[targetId] || 0;
  const next = (current % 3) + 1;
  character.special.hitCountByTarget[targetId] = next;
  return next;
}

// Blood Frenzy: hearts<=3 one-time special. Immediately unleashes a burst
// of consecutive random strikes against LIVING ENEMIES (never himself,
// never an ally in a team mode) - each strike is a full, normal Blood Hunt
// hit in every respect (shield/dodge/untargetable all apply exactly as
// they would to a normal chosen-target Blood Hunt), just with the target
// picked at random each time (fully independent per strike - the same
// enemy CAN be hit more than once in one burst) instead of player-chosen.
// Confirmed ruling, 2026-09-14: purely random, no rebalancing against the
// new per-target counters - "someone can get big damage, someone even can
// get 0 damage" is the intended chaotic spread, not a bug to smooth out.
// Each strike reads/advances whichever target it randomly lands on's own
// existing counter via nextBladeHitCount - no separate burst-only math.
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
  // carrying it over from the moment he died. Akyros's Shadow Seal's
  // lockedHearts gets the same "fresh means negative status will remove"
  // treatment - confirmed reachable, 2026-09-20: a sealed Blade dying and
  // reviving here with hearts reset to 2 could otherwise leave a stale
  // lockedHearts higher than his new real hearts (the same invalid-state
  // bug Soul Swap/Lifebond needed clampLockedHearts for - see
  // damagePipeline.js's own comment), except here the cleaner fix is a
  // full reset to 0 rather than a clamp, since he's not staying sealed at
  // all - a KO/revival is a clean break, not a continuation of whatever
  // state he died carrying.
  character.lockedHearts = 0;
  character.skipNextTurn = false;
  character.skipHeadacheTurn = false;
  // hitCountByTarget deliberately NOT cleared here - confirmed ruling,
  // 2026-09-14: "counter will not reset on rebirth". Every per-target
  // count he's built up survives his own death/revival, same as it
  // survives a target switch.
});

export const actions = {
  bloodHunt: {
    label: 'Blood Hunt',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const amount = nextBladeHitCount(character, targetId);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'bloodHunt', targetId, streak: amount, ...result });
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
      let friendshipEndLogEntry = null;
      for (let i = 0; i < strikeCount; i++) {
        // Re-queries the living pool fresh before EVERY strike (not once up
        // front) - an earlier strike in this same burst can KO someone,
        // shrinking who's left to randomly hit for the remaining strikes.
        const pool = livingEnemiesFor(character, game);
        if (pool.length === 0) break; // everyone's already down - burst ends early
        const target = pool[Math.floor(Math.random() * pool.length)];
        // Reads/advances THIS target's own independent counter, same rule
        // as a normal chosen-target Blood Hunt - a random burst hit landing
        // on someone at their 3rd-hit peak deals 3, the very next strike
        // landing on them again (or anyone else already partway through
        // their own cycle) deals whatever THEIR count is at, entirely
        // independent of every other target's own progress. Confirmed
        // ruling: purely random spread, no burst-only rebalancing.
        const amount = nextBladeHitCount(character, target.id);
        const result = applyDamage(game, log, {
          sourceCharacterId: character.id,
          targetCharacterId: target.id,
          amount,
        });
        hits.push({ targetId: target.id, streak: amount, amountDealt: result.amountDealt, dodged: result.dodged, koTriggered: result.koTriggered });
        if (result.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.rebirthLogEntry;
        if (result.mirrorLogEntry && !mirrorLogEntry) mirrorLogEntry = result.mirrorLogEntry;
        if (result.mirrorResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorResult.rebirthLogEntry;
        if (result.mirrorReflectLogEntry && !mirrorReflectLogEntry) mirrorReflectLogEntry = result.mirrorReflectLogEntry;
        if (result.mirrorReflectResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorReflectResult.rebirthLogEntry;
        if (result.fowlPlayRevertLogEntry && !fowlPlayRevertLogEntry) fowlPlayRevertLogEntry = result.fowlPlayRevertLogEntry;
        if (result.divineJudgmentTriggerLogEntry && !divineJudgmentTriggerLogEntry) divineJudgmentTriggerLogEntry = result.divineJudgmentTriggerLogEntry;
        if (result.prophecyOfDoomTriggerLogEntry && !prophecyOfDoomTriggerLogEntry) prophecyOfDoomTriggerLogEntry = result.prophecyOfDoomTriggerLogEntry;
        if (result.friendshipEndLogEntry && !friendshipEndLogEntry) friendshipEndLogEntry = result.friendshipEndLogEntry;
        if (character.isKO) break; // a mirrored/reflected counter-hit KO'd Blade himself mid-burst
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'bloodFrenzy', hits });
      return { hits, rebirthLogEntry, mirrorLogEntry, mirrorReflectLogEntry, fowlPlayRevertLogEntry, divineJudgmentTriggerLogEntry, prophecyOfDoomTriggerLogEntry, friendshipEndLogEntry };
    },
  },
};
