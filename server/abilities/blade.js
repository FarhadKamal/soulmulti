import { applyDamage, applyHeal, heartsSnapshot, registerRebirth } from '../engine/damagePipeline.js';

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

// Blood Drain (design-locked 2026-09-23): always-on from turn one, no
// hearts<=3 gate, no cast, no toggle - not a separate action at all, just a
// standing rule layered onto Blood Hunt's own existing 1->2->3 cycle.
// Confirmed rulings: "it does not require hearts<=3", "yes it apply to
// blood frenzy burst strike too. base on condition", "heal amount 1 life".
// Whenever a hit lands as the 3RD tick of a target's own cycle (the peak
// 3-damage hit) AND it actually connects for real damage (amountDealt > 0 -
// a fully dodged/shield-absorbed 3rd hit drains no blood, there's nothing
// to drain), Blade heals 1 flat heart - confirmed to fire even if that same
// hit is the killing blow (the trigger is "did a 3rd-tick hit land", not
// "did the target survive"). Deliberately NOT gated on `amount === 3`
// checked in isolation - reads `result.amountDealt` instead, so a 3rd-tick
// hit that only PARTIALLY got through (some absorbed by shield, rest
// landed) still heals, while a FULLY absorbed/dodged one (amountDealt 0)
// does not. Only computes/applies the heal here - does NOT push its own
// log entry (see the two call sites' own comments for why: bloodHunt can
// push immediately, but bloodFrenzy's burst loop must defer, since its own
// per-strike detail lives inside a `hits` array, not as separate top-level
// log entries, and its own cast flash - a single long-duration
// blood_frenzy.jpg covering the whole burst - would otherwise immediately
// stomp over any mid-loop flash before a client could ever render it).
function bloodDrainHealAmount(amount, result) {
  return (amount === 3 && result.amountDealt > 0) ? 1 : 0;
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
  // Rowan's Frog Curse - confirmed ruling, 2026-09-24: a frogged character
  // who dies and revives comes back as a normal hero, curse cleared, same
  // "fresh copy" reasoning as lockedHearts above.
  character.isFrog = false;
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
      // Blood Drain - pushed AFTER the attack's own line, same ordering
      // every other passive-heal-triggered-by-an-attack tick in this
      // codebase already uses (see Kaelis's Ashka's Vengeance, which pushes
      // its own strike line before any deferred heal-adjacent entry). Safe
      // to push directly here (unlike bloodFrenzy's own burst below) since
      // this is a single strike with no later same-turn flash competing
      // for Blade's own tile.
      if (bloodDrainHealAmount(amount, result) > 0) {
        const bloodDrainHealed = applyHeal(game, character.id, 1);
        if (bloodDrainHealed > 0) {
          log.push({ type: 'blood-drain', characterId: character.id, healed: bloodDrainHealed, hearts: heartsSnapshot(game) });
        }
      }
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
      let friendshipSpilloverLogEntry = null;
      // Melyssa's Friendship - the "friend protects Melyssa" portrait
      // reaction (portraitFlash.js's own protects_melyssa.jpg) is driven
      // entirely by entry.redirectedToFriendId on the TOP-LEVEL log entry -
      // confirmed real bug, 2026-09-21 (live report): unlike a single-
      // target attack (which gets this for free by spreading ...result
      // directly into its own entry), this custom `hits` array never
      // captured it from any individual redirected strike, so the whole
      // animation silently never fired for Blood Frenzy even when a
      // redirect genuinely happened (the damage/shield math was always
      // correct - only the visual was missing). "First occurrence wins",
      // same reasoning as every other deferred field in this loop.
      let redirectedToFriendId = null;
      // Blood Drain's running total for this whole burst - see the in-loop
      // comment further down for why this is accumulated rather than
      // applied/logged per-strike.
      let bloodDrainTotal = 0;
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
        // targetId uses result.targetCharacterId (the REAL destination),
        // not the loop's own pre-redirect target.id - confirmed real bug,
        // 2026-09-21: Melyssa's Friendship can redirect any of these
        // random hits to her friend, and the damage/hearts already
        // correctly land there, but this display field still named the
        // original random pick, showing "Melyssa" even when she was
        // never actually touched.
        hits.push({ targetId: result.targetCharacterId, streak: amount, amountDealt: result.amountDealt, dodged: result.dodged, koTriggered: result.koTriggered });
        if (result.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.rebirthLogEntry;
        if (result.mirrorLogEntry && !mirrorLogEntry) mirrorLogEntry = result.mirrorLogEntry;
        if (result.mirrorResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorResult.rebirthLogEntry;
        if (result.mirrorReflectLogEntry && !mirrorReflectLogEntry) mirrorReflectLogEntry = result.mirrorReflectLogEntry;
        if (result.mirrorReflectResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorReflectResult.rebirthLogEntry;
        if (result.fowlPlayRevertLogEntry && !fowlPlayRevertLogEntry) fowlPlayRevertLogEntry = result.fowlPlayRevertLogEntry;
        if (result.divineJudgmentTriggerLogEntry && !divineJudgmentTriggerLogEntry) divineJudgmentTriggerLogEntry = result.divineJudgmentTriggerLogEntry;
        if (result.prophecyOfDoomTriggerLogEntry && !prophecyOfDoomTriggerLogEntry) prophecyOfDoomTriggerLogEntry = result.prophecyOfDoomTriggerLogEntry;
        if (result.friendshipEndLogEntry && !friendshipEndLogEntry) friendshipEndLogEntry = result.friendshipEndLogEntry;
        // Melyssa's Friendship - a redirected strike's own spillover entry
        // (see damagePipeline.js's own comment on
        // friendshipSpilloverLogEntry), same "first occurrence wins"
        // reasoning as every other deferred entry in this loop.
        if (result.friendshipSpilloverLogEntry && !friendshipSpilloverLogEntry) friendshipSpilloverLogEntry = result.friendshipSpilloverLogEntry;
        if (result.redirectedToFriendId && !redirectedToFriendId) redirectedToFriendId = result.redirectedToFriendId;
        // Blood Drain - checked per-strike, same rule as a normal Blood
        // Hunt hit (confirmed ruling: "yes it apply to blood frenzy burst
        // strike too. base on condition"), but the actual heal/log entry is
        // DEFERRED until after the loop (see bloodDrainTotal below) -
        // confirmed real bug, 2026-09-23 (live report: "animation played.
        // but during blood frenzy end. not seen"). Pushing a 'blood-drain'
        // entry HERE, mid-loop, meant it landed in the log BEFORE this
        // burst's own 'special'/bloodFrenzy summary entry (pushed after the
        // loop ends) - and that summary entry's own cast flash
        // (blood_frenzy.jpg, portraitFlash.js) sets a long-duration flash
        // on Blade's SAME tile, immediately stomping over the drain flash
        // before a client ever had a chance to render it (multiple setFlash
        // calls to the same character within one synchronous dispatch pass
        // just leave the LAST one visible). Only the healed AMOUNT is
        // accumulated per-strike here; the actual applyHeal + log entry
        // happen once, after the summary line, so the drain flash shows
        // AFTER the cast flash finishes instead of underneath it.
        bloodDrainTotal += bloodDrainHealAmount(amount, result);
        if (character.isKO) break; // a mirrored/reflected counter-hit KO'd Blade himself mid-burst
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'bloodFrenzy', hits, ...(redirectedToFriendId ? { redirectedToFriendId } : {}) });
      // Blood Drain's own entry, pushed AFTER the burst's summary line (see
      // the in-loop comment above for why) - one combined heal for the
      // whole burst rather than one entry per triggering strike, since
      // multiple back-to-back drain flashes within the same instant would
      // just overwrite each other the same way the original bug did; a
      // single combined tick reads cleanly regardless of how many 3rd-tick
      // hits actually landed in this one cast.
      if (bloodDrainTotal > 0) {
        const bloodDrainHealed = applyHeal(game, character.id, bloodDrainTotal);
        if (bloodDrainHealed > 0) {
          // afterBloodFrenzy: true - confirmed real bug, 2026-09-23 (live
          // report: "blood drain animation work but.. blood_frenzy image
          // miss"). Pushing this entry after the summary line fixed the
          // FIRST bug (drain flash never showing at all - see the earlier
          // fix's own comment above), but immediately introduced a SECOND
          // one: portraitFlash.js's own setFlash() has no queueing - it
          // synchronously overwrites whatever flash is currently showing on
          // that character's tile, and clears its timer. The cast flash
          // (blood_frenzy.jpg) is set for a full 4500ms
          // (BLOOD_FRENZY_FLASH_DURATION_MS), but this entry's own
          // blood_drain.jpg flash fires moments later in the SAME dispatch
          // batch, immediately cutting the cast flash's display time down
          // to almost nothing. This flag tells the client to delay its own
          // flash call until the cast flash's full duration has actually
          // elapsed, rather than racing it - see portraitFlash.js's own
          // 'blood-drain' case for the matching client-side fix.
          log.push({ type: 'blood-drain', characterId: character.id, healed: bloodDrainHealed, hearts: heartsSnapshot(game), afterBloodFrenzy: true });
        }
      }
      return { hits, rebirthLogEntry, mirrorLogEntry, mirrorReflectLogEntry, fowlPlayRevertLogEntry, divineJudgmentTriggerLogEntry, prophecyOfDoomTriggerLogEntry, friendshipEndLogEntry, friendshipSpilloverLogEntry };
    },
  },
};
