import { applyDamage, applyHeal, tryTriggerCleanSlate, heartsSnapshot, registerRebirth } from '../engine/damagePipeline.js';
import { registerOnAnyDeath } from '../engine/categories/onAnyDeath.js';
import { redirectStatusTargetIfProtected } from './melyssa.js';

const SHARK_HUNT_HEARTS_THRESHOLD = 3;

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

// Rebirth: automatic, intercepts the KO the instant it would happen (see
// damagePipeline.js's KO branch, which calls this registered reset instead
// of hand-rolling Blade's own state reset inline). Only his OWN state is
// reset here - every OTHER character's stale reference to him (curse,
// freeze, marks, grudge, poison, headache, mirage stacks, a stale Rewind
// snapshot) is handled generically by onOtherRevived callbacks, one per
// affected character's own ability module (see
// engine/categories/onOtherRevived.js and each of those files' own
// registration).
registerRebirth('blade', (character, game, log) => {
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
  // Blade's own Shark Hunt (taxonomy #41, Mutual Seal) - Rebirth
  // intercepts the KO BEFORE applyDamage's normal KO branch ever flips
  // target.isKO true, so registerOnAnyDeath's own seal-clearing hook
  // (below) never fires for a Rebirth save - this is the ONLY place a
  // Rebirth-saved Blade's own seal (and the mirrored fields on whoever he
  // sealed) gets released. Releases the victim back to normal
  // targetability immediately, same "fresh copy" reasoning as isFrog
  // above.
  if (character.deepSeaSealPartnerId) {
    const partner = game?.characters?.[character.deepSeaSealPartnerId];
    if (partner) {
      partner.deepSeaSealed = false;
      partner.deepSeaSealPartnerId = null;
      partner.deepSeaEscapeAttempts = 0;
    }
  }
  character.deepSeaSealed = false;
  character.deepSeaSealPartnerId = null;
  character.deepSeaEscapeAttempts = 0;
  // Focus's own guarantee is scoped entirely to the seal - never carries
  // outside it (confirmed ruling), same "quietly expires" treatment as
  // every other Shark-Hunt-only field cleared here.
  character.special.focusedStrikeArmed = false;
  // hitCountByTarget deliberately NOT cleared here - confirmed ruling,
  // 2026-09-14: "counter will not reset on rebirth". Every per-target
  // count he's built up survives his own death/revival, same as it
  // survives a target switch.
});

// Blade's Shark Hunt (Mutual Seal, taxonomy #41) - fires the instant
// EITHER sealed party dies, from ANY source. Covers both end condition
// (b) (victim KO'd by sharkStrike) and (c) (Blade's own KO, only
// reachable via Athena's Curse Strike mirror or Divine Judgment - the two
// mechanics allowed to "reach through" the seal) symmetrically: whichever
// of the two dies, both flags clear on both sides. Registered in blade.js
// (not a shared module) since Blade is the only current source of
// deepSeaSealPartnerId, matching how Athena's own Divine Judgment cleanup
// lives in athena.js despite touching another character's state.
//
// Deferred, NOT pushed directly to `log` here - runOnAnyDeath fires from
// INSIDE applyDamage's own KO branch, before the caller's own log.push()
// for the triggering attack/special line, so a direct push here would
// land the seal-end entry BEFORE the hit that caused it (same class of
// bug this codebase already fixed once for Divine Judgment/Fowl
// Play/Friendship-end - see damagePipeline.js's runOnAnyDeath call site
// and turnEngine.js's own deferred-push comments for the full paper
// trail). Returned as deepSeaSealEndLogEntry instead, threaded through
// applyDamage's result the same way divineJudgmentTriggerLogEntry is.
registerOnAnyDeath((diedCharacterId, sourceCharacterId, isMirror, game, log) => {
  const died = game.characters[diedCharacterId];
  if (!died?.deepSeaSealPartnerId) return undefined;
  const partnerId = died.deepSeaSealPartnerId;
  const partner = game.characters[partnerId];
  died.deepSeaSealed = false;
  died.deepSeaSealPartnerId = null;
  died.deepSeaEscapeAttempts = 0;
  if (died.id === 'blade') died.special.focusedStrikeArmed = false;
  if (partner) {
    partner.deepSeaSealed = false;
    partner.deepSeaSealPartnerId = null;
    partner.deepSeaEscapeAttempts = 0;
    if (partner.id === 'blade') partner.special.focusedStrikeArmed = false;
  }
  return {
    deepSeaSealEndLogEntry: {
      type: 'deep-sea-seal-end',
      characterIds: [diedCharacterId, partnerId].filter(Boolean),
      reason: 'ko',
    },
  };
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
  // Shark Hunt (replaces Blood Frenzy entirely, same treatment Akyros's
  // Shadow Army/Melyssa's Full Control got when retired): hearts<=3
  // one-time special. Transforms Blade into a shark and drags one chosen
  // living enemy into a shared "deep sea" mutual seal (taxonomy #41) -
  // both become unreachable by any third party until the seal ends. Modeled
  // directly on Frog Curse's own targeted-status-cast shape (rowan.js),
  // the closest existing precedent.
  sharkHunt: {
    label: 'Shark Hunt',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.hearts <= SHARK_HUNT_HEARTS_THRESHOLD
      && !character.special.usedSharkHunt,
    execute(character, targetId, game, log) {
      character.special.usedSharkHunt = true;
      targetId = redirectStatusTargetIfProtected(game, targetId, character.id);
      const target = game.characters[targetId];
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'sharkHunt', targetId, blockedBy: 'cleanSlate' });
        return {};
      }
      // Deliberately NO tryIllyraDodgeStatus call - confirmed ruling: the
      // cast bypasses Illyra's passive entirely, same final behavior Frog
      // Curse's own cast was revised to (2026-09-25).
      character.deepSeaSealed = true;
      character.deepSeaSealPartnerId = targetId;
      character.special.focusedStrikeArmed = false;
      target.deepSeaSealed = true;
      target.deepSeaSealPartnerId = character.id;
      target.deepSeaEscapeAttempts = 0;
      log.push({ type: 'special', characterId: character.id, actionId: 'sharkHunt', targetId });
      return {};
    },
  },
  // Shark Strike: repeatable, gated purely on "the seal is currently
  // active" (not one-time-use) - Blade's ONLY legal action while sealed
  // (see turnEngine.js's getLegalActions override), same "hidden, only
  // reachable via an explicit override" shape as Grimtal's beastAttack.
  // Reuses Blood Hunt's own per-target hit-count cycle and Blood Drain
  // heal verbatim - this is explicitly NOT a new damage-scaling mechanic,
  // just Blood Hunt continuing against a target Blade can currently ONLY
  // ever reach via the seal.
  sharkStrike: {
    label: 'Shark Strike',
    needsTarget: true,
    hidden: true,
    isLegal: (character) => character.deepSeaSealed && !!character.deepSeaSealPartnerId,
    execute(character, targetId, game, log) {
      // targetId is always the partner in practice (turnEngine.js's
      // isValidTarget enforces this), but read the partner id directly
      // rather than trusting the passed value blindly, same defensive
      // shape snakeStrike takes with isFrog.
      const victim = game.characters[character.deepSeaSealPartnerId];
      // Focus (added 2026-09-29): if armed, this strike is guaranteed to
      // land - the flat 50% roll below is skipped entirely rather than
      // just always winning it, same "the roll never happens" shape
      // ignoresDodge already uses elsewhere. Consumed here, the instant
      // the guaranteed strike is actually taken (getLegalActions only ever
      // offers sharkStrike while armed, so this is always the next thing
      // he does).
      const wasFocused = character.special.focusedStrikeArmed;
      if (wasFocused) character.special.focusedStrikeArmed = false;
      // "Underwater dodge" - flat 50%, checked HERE (attacker-specific),
      // not in damagePipeline.js's generic dodge block, since this dodge
      // only ever applies to ONE attacker (Blade) against ONE victim,
      // unlike Frog Curse's dodge (applies to ANY attacker). The victim's
      // own normal dodge sources (Illyra's Illusion, Marin's Threefold
      // Veil, Akyros's passive, etc.) are suspended while sealed by
      // design - this flat 50% fully replaces them, not stacks with them.
      if (!wasFocused && Math.random() < 0.5) {
        // isDeepSeaDodge: true - confirmed real bug (live report: "grimtal
        // dodge.jpg was playing deep inside sea!"): the client's own
        // handleDodgeForFlash (portraitFlash.js) used to re-derive "was this
        // sealed" by reading target.deepSeaSealed off the LATEST broadcast
        // snapshot at dispatch time - but a single broadcast batch can
        // contain both this dodge AND a later entry that ends the same seal
        // (an escape success, a KO), so by the time the batch's entries are
        // walked in order, the EARLIER dodge could be checked against the
        // ALREADY-ended seal state and wrongly show the normal Grim-Ward-
        // style dodge.jpg instead of deepsea_dodge.jpg. Marking the fact
        // directly on the log entry itself (true at the moment this dodge
        // actually happened) sidesteps the staleness entirely - no longer
        // re-derived from live state at all.
        log.push({ type: 'dodge', attackerId: character.id, targetCharacterId: victim.id, isDeepSeaDodge: true, hearts: heartsSnapshot(game) });
        return { dodged: true };
      }
      const amount = nextBladeHitCount(character, victim.id);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: victim.id,
        amount,
        ignoresShield: true, // Pure Attack, confirmed ruling
        ignoresDodge: true, // the 50% roll above IS the dodge - applyDamage's own dodge stack must not ALSO run
      });
      // Focus's own guarantee is consumed the instant the strike LANDS
      // (the flat 50% roll above never even runs while armed - see the
      // isLegal-adjacent check further up this block), not merely
      // attempted - matches "after that turn when attack finish, next
      // turn focus will again available."
      log.push({ type: 'attack', characterId: character.id, actionId: 'sharkStrike', targetId: victim.id, streak: amount, ...result });
      if (bloodDrainHealAmount(amount, result) > 0) {
        const bloodDrainHealed = applyHeal(game, character.id, 1);
        if (bloodDrainHealed > 0) {
          // viaSharkStrike: true disambiguates the healing source for the
          // client (shark-form deepsea_heal.jpg instead of Blade's normal
          // blood_drain.jpg), matching the existing afterBloodFrenzy-style
          // "which source triggered this heal" flag precedent.
          log.push({ type: 'blood-drain', characterId: character.id, healed: bloodDrainHealed, hearts: heartsSnapshot(game), viaSharkStrike: true });
        }
      }
      return result;
    },
  },
  // Focus (added 2026-09-29): repeatable alternative to Shark Strike while
  // sealed - costs his whole turn (no damage dealt), guarantees his NEXT
  // Shark Strike bypasses the 50% underwater dodge entirely. Hidden (same
  // "real actions-map entry, only surfaced through an explicit
  // getLegalActions override" convention as sharkStrike itself) - offered
  // alongside sharkStrike only while the guarantee ISN'T already armed;
  // once armed, turnEngine.js's own override narrows his kit to sharkStrike
  // only until he cashes it in.
  focus: {
    label: 'Focus',
    needsTarget: false,
    hidden: true,
    isLegal: (character) => character.deepSeaSealed && !character.special.focusedStrikeArmed,
    execute(character, targetId, game, log) {
      character.special.focusedStrikeArmed = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'focus', hearts: heartsSnapshot(game) });
      return {};
    },
  },
};
