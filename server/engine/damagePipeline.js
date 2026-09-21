// Single reusable damage/heal/shield resolution path.
// Every ability routes its damage through applyDamage() so that shield
// absorption, Akyros's Dodge, Blade's Rebirth, and Athena's curse mirror
// are all handled in one place instead of duplicated per character.

import { resolveDodgeDefense } from './categories/dodgeDefense.js';
import { runOnOwnDeath } from './categories/onOwnDeath.js';
import { runOnOtherRevived } from './categories/onOtherRevived.js';
import { registerRebirth, getRebirthResetter } from './categories/rebirthRegistry.js';
import { runOnHitLanded } from './categories/onHitLanded.js';
import { runOnHitLandedEarly } from './categories/onHitLandedEarly.js';
import { runOnAnyDeath } from './categories/onAnyDeath.js';

export { registerRebirth };

// Snapshot of every character's current hearts (or 'KO') AND shield, taken
// at the exact moment of a log.push() call - stamped onto EVERY log entry
// at its own push site (not just the end-action marker executeAction/
// finalizeAction push), so the client can read entry.hearts directly
// per-line with no forward-scanning/pairing logic needed. Lives here (not
// turnEngine.js, where end-action's own usage originated) so every ability
// file can call it directly to stamp its own standalone log.push() sites
// (e.g. chronox.js's onTurnStart passives, kaelis.js's Ashka heal tick) -
// ability files already import safely from this file, and this file has
// zero imports of its own, so this avoids the same circular-import problem
// the whole category-driven refactor deliberately avoided throughout.
// Confirmed necessary 2026-08-30: a live match log showed several
// standalone log entries (turn-start passives, frozen/headache turn-skips)
// displaying a LATER action's snapshot instead of their own, because the
// original "find the next end-action" client-side approach silently
// grabbed whatever real action happened to resolve next - possibly several
// turns and several OTHER characters' actions later during a busy
// World-Stops/multi-KO stretch. Purely a display bug - no combat-
// resolution damage was ever actually misapplied.
// Akyros's Shadow Seal - lockedHearts must never exceed a character's
// current hearts (it's defined as "a portion of current hearts locked
// away," not an independent pool - see state.js's own comment). Every
// mechanic that routes hearts changes through applyDamage/applyHeal is
// automatically safe (the amount deducted/added there never pushes hearts
// below lockedHearts in a way that breaks that invariant - a KO already
// fires the instant the active pool hits 0). But a handful of abilities
// directly assign character.hearts OUTSIDE that path entirely (Zerathys's
// Soul Swap - a direct two-party exchange; Marin's Lifebond - a many-way
// average) - confirmed reachable bug, 2026-09-20: Soul Swap dropping a
// sealed character's hearts below their own lockedHearts left an invalid
// state (lockedHearts > hearts) that the KO check never re-evaluates until
// the NEXT hit lands, silently corrupting that next hit's outcome. Any
// ability that sets character.hearts directly (not through applyDamage/
// applyHeal) MUST call this immediately after, for every character whose
// hearts it touched - clamps lockedHearts down to the new hearts value,
// never up (a swap/average can only ever reveal MORE of what's already
// locked, never lock away newly-arrived hearts on its own).
export function clampLockedHearts(character) {
  if (character.lockedHearts > character.hearts) {
    character.lockedHearts = character.hearts;
  }
}

export function heartsSnapshot(game) {
  const snap = {};
  for (const c of Object.values(game.characters)) {
    snap[c.id] = c.isKO ? 'KO' : { hearts: c.hearts, shield: c.shield };
  }
  return snap;
}

// True if ANY character currently has characterId locked under their own
// Silence Lock (Rowan's special.silenceTargets Map) - written generically
// (scans every character's .special rather than assuming Rowan specifically)
// so any future silence-capable character needs no changes here. Lives here
// (not turnEngine.js, which imports it) rather than the reverse, since this
// file has zero imports of its own and turnEngine.js already imports
// applyDamage from here - keeping the dependency one-directional avoids a
// circular import between the two.
export function isSilenced(character, game) {
  return Object.values(game.characters).some(
    (c) => c.special?.silenceTargets?.has(character.id)
  );
}

// True if `character` is currently frozen by EITHER of Chronox's two freeze
// sources - Time Freeze (single target, freezeActive/freezeTargetId) or
// World Stops (multiple targets at once, worldStopsActive/
// worldStopsFrozenIds). Both live on Chronox's own object, not the frozen
// character's, same as every other "is X affected by Y" check in this file.
// This is the SINGLE generic check every freeze-aware call site in the
// codebase should use - confirmed via audit that turnEngine.js's own
// isCurrentlyFrozen, damagePipeline.js's hasNegativeStatus/
// clearNegativeStatuses, Blade's Rebirth cleanup, Chronox's own KO cleanup,
// Rowan's Purify, and botPlayer.js's rowanHasUrgentNegativeStatus ALL only
// ever checked freezeActive/freezeTargetId, silently missing World Stops
// entirely - reachable bugs, not hypothetical (e.g. Chronox dying while
// World Stops is active left every frozen target stuck frozen forever,
// since nothing else was ever tracking/clearing worldStopsFrozenIds).
export function isFrozenByChronox(character, game) {
  const chronox = game.characters.chronox;
  if (!chronox || chronox.isKO) return false;
  if (chronox.special.freezeActive && chronox.special.freezeTargetId === character.id) return true;
  if (chronox.special.worldStopsActive && chronox.special.worldStopsFrozenIds?.has(character.id)) return true;
  return false;
}

// True if character currently has any of the 5 genuine debuff-style
// negative statuses another character has placed on them (Athena's curse,
// Chronox's freeze, Akyros's Hidden Mark, Rowan's Silence Lock, Grimtal's
// Skull Crack headache) - deliberately excludes Blade's per-target hit
// count and Kaelis's grudge count, since both are the ATTACKER's own
// tracked resource rather than a status placed ON the victim (same ruling
// already established for what Rowan's Purify treats as "urgent" vs. what
// it merely sweeps up as a side effect - see rowanHasUrgentNegativeStatus
// in botPlayer.js). Used by Marin's Clean Slate: both its reactive trigger
// condition (fires the first time this becomes true) and, while her
// immunity window is active, to block these 5 specific status-applications
// from landing on her at all (see the isImmuneToNegativeStatus carve-outs
// in each ability file below). Deliberately does NOT cover Poison Cloud -
// confirmed scope decision, she's still vulnerable to Rowan's poison same
// as anyone else.
export function hasNegativeStatus(character, game) {
  if (isFrozenByChronox(character, game)) return true;
  return Object.values(game.characters).some((c) => {
    if (c.id === character.id) return false;
    const s = c.special;
    if (!s) return false;
    if (s.curseTargetCharacterId === character.id) return true;
    if (s.marks?.has(character.id)) return true;
    if (s.silenceTargets?.has(character.id)) return true;
    if (s.headacheVictimId === character.id && s.headacheRollPending) return true;
    return false;
  });
}

// Actually clears every one of the 4 covered statuses currently active on
// `character`, wherever they live on the CASTER's own .special (matches the
// scan shape of hasNegativeStatus above). Used by Clean Slate's discovery-
// time cleanse (marin.js's onTurnStart) - confirmed bug: Clean Slate's
// reactive trigger only ever intercepted a NEW status-application attempt,
// never checked or cleared a status that was already active on her from
// BEFORE Clean Slate was even discovered, so an old curse cast several
// turns earlier stayed silently active and eventually mirrored damage back
// on her long after "cleansed and protected!" had already logged. Mirrors
// Rowan's own Purify cleanse logic (per-status clearing pattern) but scoped
// to just the 4 statuses Clean Slate actually covers, not every status in
// the game.
export function clearNegativeStatuses(character, game, log) {
  for (const c of Object.values(game.characters)) {
    if (c.id === character.id) continue;
    const s = c.special;
    if (!s) continue;
    if (s.curseTargetCharacterId === character.id) s.curseTargetCharacterId = null;
    if (s.freezeActive && s.freezeTargetId === character.id) {
      s.freezeActive = false;
      s.freezeTargetId = null;
      character.skipNextTurn = false;
      log.push({ type: 'freeze-end', targetCharacterId: character.id, hearts: heartsSnapshot(game) });
    }
    // World Stops is a SHARED countdown across a whole group - cleansing
    // just THIS character removes them alone from the frozen set (un-skips
    // their turn), it does NOT end the freeze for everyone else still in
    // it. Only clears worldStopsActive entirely if removing this character
    // happens to empty the set (matches how the natural onTurnStart
    // countdown already treats "no one left frozen" - see chronox.js).
    if (s.worldStopsActive && s.worldStopsFrozenIds?.has(character.id)) {
      s.worldStopsFrozenIds.delete(character.id);
      character.skipNextTurn = false;
      if (s.worldStopsFrozenIds.size === 0) s.worldStopsActive = false;
      log.push({ type: 'world-stops-end', targetCharacterId: character.id, hearts: heartsSnapshot(game) });
    }
    if (s.marks?.has(character.id)) s.marks.delete(character.id);
    if (s.revealedMarks?.has(character.id)) s.revealedMarks.delete(character.id);
    if (s.silenceTargets?.has(character.id)) s.silenceTargets.delete(character.id);
    if (s.headacheVictimId === character.id) {
      s.headacheVictimId = null;
      s.headacheRollPending = false;
    }
  }
}

// Melyssa's Friendship (design-locked 2026-09-20) - unlike
// clearNegativeStatuses above (which sweeps every OTHER character's status
// on `character`, used for a full cleanse like Purify/Clean Slate), this
// clears only whatever ONE SPECIFIC character (`fromCharacterId`) currently
// has placed on `character` - confirmed ruling: "if Athena casted judgement
// strike or curse strike to melyssa... now melyssa cast friendship of
// athena... melyssa's judgement strike or curse status will remove", scoped
// specifically to the new friend's own attribution, not a blanket sweep
// from every source. Covers every status type this project tracks
// per-caster against a victim - confirmed ruling: "everything attributable
// to that friend" - including Rowan's poison (poisonTargets, stored on the
// POISONER's own special, keyed by victim id - see rowan.js). Kaelis's
// grudgeCounts is deliberately NOT included here: that field is stored on
// the VICTIM's own special, keyed by ATTACKER id (the opposite direction -
// "how many times has each attacker hit ME"), and only Kaelis's own
// baseSpecialFor shape even has it - `character` here is Melyssa, who has
// no grudgeCounts field of her own to clear, so this case can never
// actually apply to her.
export function clearStatusesFromOneSource(character, game, log, fromCharacterId) {
  const from = game.characters[fromCharacterId];
  if (!from) return;
  const s = from.special;
  if (!s) return;
  if (s.curseTargetCharacterId === character.id) s.curseTargetCharacterId = null;
  if (s.divineJudgmentTargetId === character.id) s.divineJudgmentTargetId = null;
  if (s.freezeActive && s.freezeTargetId === character.id) {
    s.freezeActive = false;
    s.freezeTargetId = null;
    character.skipNextTurn = false;
    log.push({ type: 'freeze-end', targetCharacterId: character.id, hearts: heartsSnapshot(game) });
  }
  if (s.worldStopsActive && s.worldStopsFrozenIds?.has(character.id)) {
    s.worldStopsFrozenIds.delete(character.id);
    character.skipNextTurn = false;
    if (s.worldStopsFrozenIds.size === 0) s.worldStopsActive = false;
    log.push({ type: 'world-stops-end', targetCharacterId: character.id, hearts: heartsSnapshot(game) });
  }
  if (s.marks?.has(character.id)) s.marks.delete(character.id);
  if (s.revealedMarks?.has(character.id)) s.revealedMarks.delete(character.id);
  if (s.silenceTargets?.has(character.id)) s.silenceTargets.delete(character.id);
  if (s.headacheVictimId === character.id) {
    s.headacheVictimId = null;
    s.headacheRollPending = false;
  }
  if (s.poisonTargets?.has(character.id)) s.poisonTargets.delete(character.id);
}

// True while Marin's Clean Slate immunity window is actively blocking new
// negative statuses from landing on her (see marin.js's onTurnStart for the
// countdown). Checked at each of the 4 status-application sites below
// (curseStrike, timeFreeze, hiddenMark, silenceLock - NOT poisonCloud, a
// confirmed scope decision) - the underlying ACTION/damage still resolves
// normally, only the status side effect is suppressed, so she isn't made
// untargetable by these abilities entirely (a curse/freeze/mark cast into
// her during the window still needs to be a legal move that simply has no
// lasting effect, not an illegal one - same reasoning as why this lives
// inside each ability's own execute rather than as a blanket isValidTarget
// rejection).
export function isImmuneToNegativeStatus(character, game) {
  return character.id === 'marin' && character.special?.cleanSlateImmuneTurnsRemaining > 0;
}

// Called at each of the 4 status-application sites (curseStrike, timeFreeze,
// hiddenMark, silenceLock) right before the status would be
// written onto the target. Returns true if Marin's Clean Slate consumed
// this attempt - the caller must then skip applying its own status (the
// underlying damage/action itself, if any, still resolves normally, only
// the status side effect is suppressed). Two separate cases handled here:
// - Armed and dormant (cleanSlateArmed, first negative status ever): fires
//   for the first time, consuming the arm and starting the 3-turn immunity
//   window - this attempt itself never lands, since Clean Slate reacts
//   fast enough to cleanse "as it happens."
// - Already fired and immune (cleanSlateImmuneTurnsRemaining > 0): simply
//   blocks every further attempt for the rest of the window, same as
//   isImmuneToNegativeStatus's own check.
// A character who is neither armed nor immune (spell not yet discovered,
// or the one-time trigger already spent and its window expired) returns
// false here every time, letting statuses land normally - matching every
// other character's baseline behavior.
export function tryTriggerCleanSlate(target, game, log) {
  if (target.id !== 'marin') return false;
  if (isImmuneToNegativeStatus(target, game)) return true;
  if (target.special?.cleanSlateArmed) {
    target.special.cleanSlateArmed = false;
    target.special.cleanSlateImmuneTurnsRemaining = 3;
    log.push({ type: 'clean-slate-trigger', characterId: target.id });
    return true;
  }
  return false;
}

// Illyra's passive against STATUS-application attempts specifically (Curse
// Strike, Time Freeze, Hidden Mark, Silence Lock, Grimtal's Skull Crack
// headache) - none of these route their status side effect through
// applyDamage at all (only their direct damage, if any, does), so her 50%
// dodge needs this separate hook called at each of those 5 sites,
// mirroring tryTriggerCleanSlate's exact call shape. Same underlying rule
// as her applyDamage dodge block: a fresh, unconditional 50% roll every
// single attempt, no memory, no exceptions beyond mirror/poison (neither
// of which reach these 5 sites anyway, since none of them are mirrored or
// poison-tick sources). Returns true if the status attempt is dodged - the
// caller must then skip applying its own status, same contract as
// tryTriggerCleanSlate. The underlying action/damage still resolves
// normally either way; only the status side effect is what's being rolled
// against here.
export function tryIllyraDodgeStatus(target, game, log, attackerId) {
  if (target.id !== 'illyra') return false;
  if (Math.random() < 0.5) {
    log.push({ type: 'dodge', attackerId, targetCharacterId: target.id });
    return true;
  }
  return false;
}

// Grimtal's Beast Form (Death-Triggered Reversion #36) - while active, he's
// immune to any NEW negative status being applied. Deliberately does NOT
// need to be threaded into every one of the 7 other status-application
// sites Clean Slate/Illyra's dodge already hook (Curse Strike, Time Freeze
// x2, Hidden Mark, Silence Lock, Skull Crack) the way those two are -
// Beast Form also sets `character.untargetable = true`, and every one of
// those 7 is a player-PICKED target routed through turnEngine.js's
// isValidTarget (which already rejects any untargetable character at the
// targeting-UI layer itself, same protection Velorya's Lunar Eclipse
// already relies on) - so he can never be legally selected as their target
// in the first place. Only wired in explicitly where something has its OWN
// dedicated bypass-untargetable mechanism: applyDamage's own check below
// (covers Fowl Play's chicken status, and any future Environmental-Attack-
// shaped damage source that sets ignoresUntargetable), and boingo.js's
// fowlPlay.execute (excludes him from
// the chicken-victim candidate pool directly, since isChicken itself is set
// outside applyDamage). An already-active status from BEFORE he transformed
// is untouched either way (this only blocks fresh applications) -
// transforming does not cleanse anything, matching Fowl Play's own
// "in-progress state is preserved" rule elsewhere.
export function tryBeastFormImmunity(target, game) {
  return target.id === 'grimtal' && !!target.special?.beastFormActive;
}

export function applyDamage(game, log, {
  sourceCharacterId,
  targetCharacterId,
  amount,
  ignoresShield = false,
  ignoresUntargetable = false,
  isMirror = false,
  isPoisonTick = false,
  // Kaelis's Ashka's Vengeance (hearts<=3 passive) - confirmed ruling,
  // 2026-09-07: "kaleis will not suffer what ashka did" - a Counter Attack
  // reaction (Rowan's Mirror Reflect, Athena's curse-mirror) triggered by
  // Ashka's own independent bonus strike must NOT bounce back onto Kaelis
  // herself, since the strike is her phoenix companion acting on its own,
  // not a direct attack she personally made. Threaded through to both
  // onHitLandedEarly/onHitLanded's own ctx the same way isPoisonTick is,
  // and checked by each Counter-Attack-shaped callback exactly like their
  // own existing isMirror/isChicken exclusions.
  isAshkaStrike = false,
  // Illyra's Mirage Burst is the first (and so far only) source that needs
  // to bypass EVERY dodge mechanic in the game uniformly - not just one
  // character's, all of them (Akyros, Marin, Grimtal, and Illyra's own
  // passive too), since it's detonating an already-planted mark rather
  // than landing a fresh attack the target could actually evade. Rather
  // than adding a bespoke exclusion to each of the 4 dodge blocks
  // individually, this single flag gates all of them at once.
  ignoresDodge = false,
  // Boingo's Fowl Play - confirmed ruling: "NO SHIELD NO DODGE NO
  // UNTERGATABBLE NO IMMORTAL during chicken status" - a chicken attack
  // bypasses every defensive mechanic in the game uniformly, including
  // Draxus's Deathless Fury floor (the one immortal mechanic in the
  // roster, hardcoded below rather than category-driven like Dodge
  // Defense - no existing bypass flag for it before this, since nothing
  // else in the game has ever needed to skip it). Only chickenAttack sets
  // this true (executeChickenAttack in turnEngine.js).
  ignoresImmortal = false,
  // Boingo's Fowl Play - confirmed ruling: "not even rebirth possible" -
  // extends the same "pure damage, no defense of any kind" rule to
  // Blade's Rebirth too. A chicken-attack KO is final: his one-time
  // Rebirth stays UNUSED/banked (rebirthUsed never flips true) if a
  // chicken attack is what kills him, available again as normal the next
  // time he'd otherwise die to a real attack. Only chickenAttack sets
  // this true.
  ignoresRebirth = false,
}) {
  const target = game.characters[targetCharacterId];
  const result = {
    targetCharacterId,
    amountDealt: 0,
    absorbed: 0,
    dodged: false,
    revived: false,
    koTriggered: false,
    mirrorResult: null,
  };

  if (!target || target.isKO) return result;

  // Boingo's Fowl Play - confirmed ruling (repeated live after a real bug):
  // "dodge will not work during chicken status" - a chickenified TARGET
  // has zero defense of any kind against ANY attack, not just a Chicken
  // Attack specifically. Originally only chickenAttack itself passed the
  // ignores* flags below, which correctly covered chicken-vs-chicken/
  // chicken-vs-Boingo damage but missed the reverse direction entirely: a
  // NON-chicken attacker (e.g. Boingo's own Chaos Gamble) landing on a
  // chickenified target still respected Illyra's dodge passive, since
  // Chaos Gamble never sets ignoresDodge. Confirmed live: "Illyra dodged
  // Boingo's attack!" appeared AFTER she'd already been turned into a
  // chicken. Fixed by making this a property of the TARGET, checked once
  // here and forced onto every ignores* flag unconditionally, rather than
  // relying on every possible attacker to opt in individually - covers
  // every current and future damage source automatically.
  if (target.isChicken) {
    ignoresUntargetable = true;
    ignoresDodge = true;
    ignoresShield = true;
    ignoresImmortal = true;
    ignoresRebirth = true;
  }

  // Melyssa's Friendship (design-locked 2026-09-20, Redirect Bond) - total
  // redirect: any damage that would land on Melyssa while she has an active
  // friend redirects to him instead, BEFORE any of her own defenses are
  // even considered (this must be the very first thing checked, ahead of
  // isChicken/dodge/shield/everything - she is simply never actually hit
  // while the bond holds, the friend is). Deliberately does NOT apply when
  // Melyssa herself is the sourceCharacterId - confirmed ruling: "if
  // melyssa control her friend and use earthshatter... she can take random
  // damage on that... because tharox cannot protect her because tharox is
  // casting earthshatter" - when SHE chooses to puppet the friend into
  // something that also hits her, that's her own informed gamble, not an
  // attack FROM someone else, so the redirect is suspended for that one
  // hit only (checked per-call via sourceCharacterId, not a global flag -
  // no other hit in the same batch is affected).
  //
  // Respects the FRIEND's own full defense stack (shield/dodge/immunities)
  // as if he were the original target (confirmed ruling) - achieved simply
  // by re-running applyDamage against him instead of Melyssa, rather than
  // hand-rolling a parallel damage calculation here. If the redirected
  // amount would exceed his current remaining hearts, the leftover spills
  // back onto MELYSSA (confirmed ruling, walked through with an exact
  // worked example: friend already has 3 hearts left, a 5-damage redirect
  // KOs him and the remaining 2 lands on her) - that spillover in turn
  // respects HER OWN shield (recursing back into this same function a
  // second time, now genuinely targeting her, with the redirect check
  // skipped since friendId is used up / no longer relevant to this
  // specific leftover amount).
  // Confirmed real bug, 2026-09-21: mutual no-attack is normally what
  // prevents this, but Boingo's Fowl Play chicken status overrides EVERY
  // kit-based rule in the game (confirmed ruling: chicken status overrides
  // Friendship's own mutual no-attack the same way it overrides everything
  // else) - so a chickenified friend CAN end up as the direct attacker
  // against a chickenified Melyssa. Redirecting his own attack back onto
  // himself would be nonsensical (he'd just be hitting himself), so he's
  // explicitly excluded from being his OWN redirect destination - the hit
  // simply lands on Melyssa directly in that one specific case, same as if
  // she had no friend at all.
  if (target.id === 'melyssa' && !target.isKO && sourceCharacterId !== 'melyssa') {
    const friendId = target.special.friendCharacterId;
    const friend = (friendId && friendId !== sourceCharacterId) ? game.characters[friendId] : null;
    if (friend && !friend.isKO) {
      const beforeHearts = friend.hearts;
      const redirectedResult = applyDamage(game, log, {
        sourceCharacterId, targetCharacterId: friendId, amount,
        ignoresShield, ignoresUntargetable, isMirror, isPoisonTick, isAshkaStrike,
        ignoresDodge, ignoresImmortal, ignoresRebirth,
      });
      result.amountDealt = redirectedResult.amountDealt;
      result.absorbed = redirectedResult.absorbed;
      result.dodged = redirectedResult.dodged;
      result.koTriggered = redirectedResult.koTriggered;
      result.redirectedToFriendId = friendId;
      // Confirmed real bug, 2026-09-21: every attack-type log entry spreads
      // this `result` object AFTER its own `targetId` field (e.g.
      // executeChickenAttack's `log.push({ ..., targetId, ...result })`),
      // so result.targetCharacterId (initialized above to Melyssa's own
      // id, the original call's targetCharacterId) is what the client's
      // actualAttackTargetId() actually displays - left at its original
      // value, the log line still read "on Melyssa" even when the hit
      // genuinely redirected and landed on the friend instead, completely
      // misleading (her own hearts never moved, but the friend's did).
      // Overwritten here to the real destination so every existing display
      // site picks it up automatically, no client changes needed.
      result.targetCharacterId = friendId;
      if (redirectedResult.rebirthLogEntry) result.rebirthLogEntry = redirectedResult.rebirthLogEntry;
      // Spillover: only possible if the friend actually KO'd from this
      // redirected hit (if he survived, his hearts - however low -
      // genuinely covered the full amount by definition, since applyDamage
      // never lets hearts go negative). His `amountDealt` on the
      // redirected hit is exactly how much reached his hearts (the same
      // meaning that field has everywhere else in this codebase); the
      // remainder of his PRE-HIT hearts total (beforeHearts) beyond that
      // amountDealt is what he could never actually absorb - confirmed
      // ruling, walked through with an exact worked example (friend at 3
      // hearts, a 5-damage redirect KOs him, the leftover 2 lands on her).
      // Deliberately does NOT reapply shield/dodge/untargetable on the
      // spillover itself (ignoresUntargetable: true, ignoresDodge: true) -
      // it's not a fresh attack choosing her as a target, it's damage that
      // already "landed" and simply had nowhere else to go; her own SHIELD
      // still applies normally though (confirmed ruling), since
      // ignoresShield is passed through from the original call unchanged.
      if (redirectedResult.koTriggered) {
        const overflow = amount - result.absorbed - beforeHearts;
        if (overflow > 0) {
          const spilloverResult = applyDamage(game, log, {
            sourceCharacterId, targetCharacterId: 'melyssa', amount: overflow,
            ignoresShield, ignoresUntargetable: true, isMirror, isPoisonTick, isAshkaStrike,
            ignoresDodge: true, ignoresImmortal, ignoresRebirth,
          });
          // Confirmed real bug, 2026-09-21 (live report, deep-dive
          // reproduction): the combined amountDealt (e.g. "5 damage" from
          // 3 to the friend + 2 spillover to her) was folded into ONE
          // number with no breakdown, and if the overflow was itself
          // lethal to her, she died completely invisibly - the log line
          // only ever named the friend ("...on Boingo - 5 damage - KO!"),
          // her own death was never mentioned anywhere, and the
          // Friendship bond's own end-of-bond line never fired either
          // (melyssa.js's onAnyDeath callback bails out via `if (!melyssa
          // || melyssa.isKO) return undefined` - by the time it would
          // check "did my friend just die," she's already marked KO'd
          // herself from this exact spillover, so it silently no-ops).
          // Deferred (returned, not pushed to `log` here) - same "runs
          // mid-way through the outer action's own execute(), before its
          // own log.push()" timing every other deferred entry in this file
          // already accounts for.
          if (spilloverResult.amountDealt > 0 || spilloverResult.koTriggered) {
            result.friendshipSpilloverLogEntry = {
              type: 'friendship-spillover', characterId: 'melyssa',
              friendCharacterId: friendId, amountDealt: spilloverResult.amountDealt,
              koTriggered: spilloverResult.koTriggered,
            };
          }
          result.amountDealt += spilloverResult.amountDealt;
          result.absorbed += spilloverResult.absorbed;
          // Confirmed real bug, found alongside the spillover-visibility
          // one above: this used to be a flat overwrite
          // (`result.koTriggered = spilloverResult.koTriggered`), which
          // incorrectly flipped the top-level KO flag back to FALSE
          // whenever the friend died but the overflow wasn't ALSO lethal
          // to Melyssa - hiding the "- KO!" suffix on the friend's own
          // death in the primary log line even though redirectedResult
          // (checked just above, at line ~445) already correctly proved
          // someone genuinely died. The friend's own death and Melyssa's
          // own spillover death are two independent KO outcomes from one
          // action - true if EITHER happened, not just whichever happened
          // to be checked last.
          result.koTriggered = redirectedResult.koTriggered || spilloverResult.koTriggered;
          result.revived = spilloverResult.revived;
          if (spilloverResult.rebirthLogEntry) result.rebirthLogEntry = spilloverResult.rebirthLogEntry;
        }
      }
      return result;
    }
  }

  // Untargetable is enforced primarily at the targeting UI layer; this is a
  // defensive re-check so a bug upstream can't sneak damage through.
  if (target.untargetable && !ignoresUntargetable) {
    return result;
  }

  // Grimtal's Beast Form (Death-Triggered Reversion #36) - a hard,
  // UNCONDITIONAL damage-immunity floor, deliberately checked AFTER the
  // ignoresUntargetable-respecting check above rather than folded into it.
  // Confirmed ruling: complete damage immunity while transformed, not a
  // floor-at-1 (unlike Draxus's Deathless Fury) - and critically, this must
  // hold even against sources that explicitly bypass untargetable (Fowl
  // Play's chicken status, any future Environmental Attack), which the
  // plain `target.untargetable` check above alone would
  // NOT stop, since those sources set ignoresUntargetable: true precisely
  // to defeat that check. No `ignores*` flag can override this - it is not
  // itself one of the ignores* flags, by design, since nothing in the game
  // has ever needed to bypass Beast Form specifically.
  if (tryBeastFormImmunity(target, game)) {
    return result;
  }

  let amt = amount;

  // Confirmed ruling: a character currently frozen (Time Freeze OR World
  // Stops - see isFrozenByChronox) cannot use ANY of their own dodge
  // mechanics against other incoming attacks while frozen - a sitting
  // target, no exceptions. Computed once and gates all four dodge blocks
  // below identically. Illyra specifically: her 50% passive is suppressed
  // the same way while she's frozen, resuming automatically the instant
  // her own frozen status is lifted (no separate flag needed - this check
  // is always live against her CURRENT frozen state).
  const isFrozen = isFrozenByChronox(target, game);

  // Dodge Defense (category-driven, see engine/categories/dodgeDefense.js):
  // dispatches to whichever of Akyros/Marin/Grimtal/Illyra's own registered
  // provider matches `target.id`, replacing what used to be 4 separate
  // inline `if (target.id === '<name>' ...)` blocks here. Behavior
  // (including exact ordering/short-circuiting) is unchanged - see the
  // provider registrations in each character's own abilities/*.js file for
  // the per-character rules this now dispatches to generically.
  if (resolveDodgeDefense(game, log, target, sourceCharacterId, { isMirror, ignoresDodge, isFrozen, isPoisonTick })) {
    result.dodged = true;
    // Confirmed real bug, 2026-09-12: the 'dodge' entry dodgeDefense.js
    // pushes never carried its own hearts snapshot, so a dodge occurring
    // MID a multi-hit burst (Blade's Blood Frenzy, Grimtal's Grim Barrage -
    // any special whose loop routes each hit through this same applyDamage,
    // sharing one `log` array across several strikes) had its display
    // snapshot forward-scanned to the batch's single trailing end-action
    // marker instead of its own true state at the moment it happened -
    // showing a LATER strike's outcome (even a KO from a strike several
    // iterations later in the same burst) on the dodge line. Stamped here
    // rather than inside dodgeDefense.js itself, since that file can't
    // import heartsSnapshot without a circular import (damagePipeline.js
    // already imports resolveDodgeDefense FROM it).
    log[log.length - 1].hearts = heartsSnapshot(game);
    return result;
  }

  if (!ignoresShield && target.shield > 0) {
    const absorbed = Math.min(target.shield, amt);
    target.shield -= absorbed;
    amt -= absorbed;
    result.absorbed = absorbed;
  }

  const heartsBefore = target.hearts;
  target.hearts = Math.max(0, target.hearts - amt);
  result.amountDealt = amt;

  // Populated by onOwnDeath callbacks that need to hand data forward to the
  // LATER onHitLanded dispatch within this same applyDamage call (e.g.
  // Athena's { preClearCursedId } - see athena.js).
  const hitLandedCtxExtra = {};

  // Early onHitLanded dispatch (see engine/categories/onHitLandedEarly.js) -
  // at this SAME original call site, before the KO/Rebirth branch, for
  // reactions that need to see hearts exactly as reduced by absorption
  // above. See rowan.js's own registerOnHitLandedEarly call for the actual
  // Mirror Reflect logic.
  const earlyExtra = runOnHitLandedEarly(target, game, log, {
    amountDealt: result.amountDealt, isMirror, isPoisonTick, isAshkaStrike, sourceCharacterId, heartsBefore,
  });
  if (earlyExtra) Object.assign(result, earlyExtra);

  // Akyros's Shadow Seal - a KO can now fire from the ACTIVE pool
  // (hearts - lockedHearts) hitting 0 even while real hearts reads higher
  // (see the KO branch below), so every defensive mechanic that gates on
  // "would this hit actually kill" must check the same active-pool
  // condition, not the plain hearts === 0 every character effectively
  // still uses outside a Shadow Seal window (lockedHearts defaults to 0,
  // so this is equivalent for everyone else). Confirmed reachable bug,
  // 2026-09-20: Rebirth/Deathless Fury only ever checked hearts === 0,
  // silently skipping their own intercept entirely for a sealed character
  // whose active pool was exhausted while real hearts was still nonzero -
  // confirmed ruling: these defensive mechanics should still get a chance
  // to trigger, same as against any other KO source.
  const wouldKO = target.hearts - target.lockedHearts <= 0;

  // Rebirth (category-driven, see engine/categories/rebirthRegistry.js +
  // onOtherRevived.js): automatic, intercepts the KO the instant it would
  // happen. `rebirthResetter` looks up whichever character's own module
  // registered a Rebirth reset (currently only Blade) - `!target.special.
  // rebirthUsed` still gates it here rather than inside the resetter, since
  // "already used" is a universal one-shot Rebirth precondition, not
  // something specific to any one character's reset logic.
  const rebirthResetter = getRebirthResetter(target.id);
  if (rebirthResetter && wouldKO && !target.special.rebirthUsed && !ignoresRebirth) {
    rebirthResetter(target, game, log);
    result.revived = true;
    // Every OTHER character's stale reference to the now-revived target
    // (curse, freeze, marks, grudge, poison, headache, mirage stacks, a
    // stale Rewind snapshot) is handled generically here - see each
    // affected character's own onOtherRevived registration.
    runOnOtherRevived(target.id, game, log);
    // Deferred (not pushed to `log` here) and returned on the result so
    // executeAction() can push it AFTER the triggering attack's own log
    // entry - otherwise it lands BEFORE that entry in the log, since this
    // runs mid-way through the ability's execute(), before its own
    // log.push() for the attack/special line itself.
    result.rebirthLogEntry = { type: 'rebirth', targetCharacterId };
  } else if (target.id === 'draxus' && wouldKO
    && (target.special.deathproofActive || target.special.reviveImmortalActive) && !ignoresImmortal) {
    // Floors at 1 instead of KO - NOT a revival event (isKO is never set,
    // no "comes back fresh" cleanup like Rebirth's above, since he never
    // actually died: his hearts never truly reach/stay at 0). Deliberately
    // NOT flipped off here, unlike Blade's one-shot rebirthUsed - stays
    // active and re-triggers for every subsequent qualifying hit (any
    // source: direct attacks, curse mirrors, Jester Ball explosions, all
    // of which route through this same applyDamage) until his own
    // onTurnStart clears it (draxus.js), at the start of his own next turn.
    //
    // reviveImmortalActive (Resurrection Gamble, taxonomy #32) shares this
    // exact same floor mechanism - confirmed ruling: "immortal will stay
    // untill his second turn come", the same one-turn-delayed-clear shape
    // as deathproofActive, just a separate flag (see draxus.js's own
    // onTurnStart) since the two windows are conceptually distinct even
    // though they never overlap in practice.
    target.hearts = 1;
    // Akyros's Shadow Seal - flooring hearts to 1 could otherwise leave
    // lockedHearts (captured before this hit) higher than the new hearts
    // value, the same invalid-state bug Soul Swap/Lifebond needed
    // clampLockedHearts for (see that helper's own comment). A no-op for
    // anyone not currently sealed.
    clampLockedHearts(target);
    result.deathproofSave = true;
  } else if (wouldKO) {
    // Akyros's Shadow Seal - a victim with locked hearts KOs the instant
    // their ACTIVE pool (hearts - lockedHearts) is exhausted, even though
    // `hearts` itself may still read higher; the locked portion is simply
    // lost/irrelevant on death (confirmed ruling - see state.js's
    // lockedHearts comment). lockedHearts is 0 for every character outside
    // a Shadow Seal window, so this is equivalent to the old `target.hearts
    // === 0` check for everyone else.
    target.isKO = true;
    result.koTriggered = true;
    // KO-branch cleanup (see engine/categories/onOwnDeath.js): dispatches
    // to Akyros/Athena/Chronox/Rowan/Grimtal's own registered onOwnDeath
    // callback, replacing what used to be separate
    // `if (target.id === '<name>') { ...cleanup... }` blocks here. A
    // callback's return value (e.g. Athena's { preClearCursedId }) is
    // merged onto `hitLandedCtxExtra`, threaded into the LATER onHitLanded
    // dispatch further down this same call - see athena.js's own
    // registerOnOwnDeath/registerOnHitLanded pair for why: her curse-mirror
    // trigger (a late onHitLanded callback) needs to still see who was
    // cursed even though this earlier callback already cleared it - the
    // killing blow itself landed while she was alive and should still
    // mirror, only hits AFTER her death shouldn't.
    const ownDeathExtra = runOnOwnDeath(target, game, log);
    if (ownDeathExtra) {
      // Boingo's Fowl Play: a deferred log entry, NOT data for the later
      // onHitLanded dispatch (unlike Athena's own preClearCursedId use of
      // this same return value) - pulled out separately and NOT merged
      // into hitLandedCtxExtra, same "defer it, don't push here" reasoning
      // as rebirthLogEntry just above. Confirmed bug (2026-09-03): pushing
      // this directly inside the onOwnDeath callback (as it originally
      // did) landed the "X turn back into heroes!" line BEFORE the
      // triggering hit's own descriptive line (e.g. a poison tick's own
      // "takes 1 poison damage - KO!"), since this callback runs mid-way
      // through applyDamage, before that caller's own log.push(). Deferred
      // the same way so finalizeAction/tickPoisonIfAny push it AFTER their
      // own line instead.
      // Oraclus's Prophecy of Doom, fired via boingo.js's own onOwnDeath
      // callback (Boingo dying mid-Fowl-Play-window is one of the two ways
      // a PENDING (chicken-death-delayed) meteor strike can finally fire) -
      // same deferred-log-entry reasoning as fowlPlayRevertLogEntry right
      // above, pulled out the same special way rather than merged into
      // hitLandedCtxExtra.
      // Melyssa's Friendship - boingo.js's own onOwnDeath callback can now
      // also surface friendshipEndLogEntry/friendshipSpilloverLogEntry
      // (from its own inlined Prophecy-of-Doom-pending-after-chicken loop,
      // confirmed real bug, 2026-09-21) - pulled out the same explicit way
      // as fowlPlayRevertLogEntry/prophecyOfDoomTriggerLogEntry, NOT left
      // to fall into `...rest`/hitLandedCtxExtra, since that bag is read as
      // CONTEXT DATA by other onHitLanded callbacks (e.g. Athena's
      // preClearCursedId), never automatically forwarded onto `result` the
      // way every other deferred log entry field needs to be.
      const {
        fowlPlayRevertLogEntry, prophecyOfDoomTriggerLogEntry: pendingProphecyEntry,
        friendshipEndLogEntry: ownDeathFriendshipEndLogEntry,
        friendshipSpilloverLogEntry: ownDeathFriendshipSpilloverLogEntry,
        ...rest
      } = ownDeathExtra;
      if (fowlPlayRevertLogEntry) result.fowlPlayRevertLogEntry = fowlPlayRevertLogEntry;
      if (pendingProphecyEntry) result.prophecyOfDoomTriggerLogEntry = pendingProphecyEntry;
      if (ownDeathFriendshipEndLogEntry) result.friendshipEndLogEntry = ownDeathFriendshipEndLogEntry;
      if (ownDeathFriendshipSpilloverLogEntry) result.friendshipSpilloverLogEntry = ownDeathFriendshipSpilloverLogEntry;
      if (Object.keys(rest).length > 0) Object.assign(hitLandedCtxExtra, rest);
    }
    // The Jester Ball is orphaned if its current holder dies from a hit
    // that has nothing to do with the ball itself (e.g. a normal attack,
    // not them choosing to Take it) - nothing else in the codebase ever
    // notices a dead character is still "holding" it, since
    // charactersActingThisTurn filters to living characters only, so the
    // held-holder's own turn (where the take/pass choice would normally
    // resolve it) simply never comes up again for the rest of the match.
    // Confirmed live: Boingo's 2nd Jester Ball stayed permanently illegal
    // (isLegal requires !game.jesterBall) because a KO'd Marin was still
    // recorded as the holder from several turns earlier. Just clears the
    // ball state here rather than resolving a real explosion - the
    // holder's already dead, there's no one left to deal damage to. Not
    // character-specific (no ability module "owns" this), so it stays
    // generic engine logic rather than a registered callback.
    if (game.jesterBall && game.jesterBall.holderCharacterId === target.id) {
      game.jesterBall = null;
    }
    // onAnyDeath dispatch (see engine/categories/onAnyDeath.js): Grimtal's
    // Grim Strike own-kill/unclaimed-kill bookkeeping now lives in his own
    // ability file's registered callback, replacing the inline
    // `if (target.id !== 'grimtal') { ... }` block that used to be here.
    // Athena's Divine Judgment trigger also hangs off this same dispatch -
    // its own deferred log entry is pulled out and merged onto `result`
    // here, same "defer it, don't push inside the callback" pattern as
    // fowlPlayRevertLogEntry above, so finalizeAction can push it AFTER
    // this action's own triggering log line instead of before it.
    const anyDeathExtra = runOnAnyDeath(target.id, sourceCharacterId, isMirror, game, log);
    if (anyDeathExtra?.divineJudgmentTriggerLogEntry) {
      result.divineJudgmentTriggerLogEntry = anyDeathExtra.divineJudgmentTriggerLogEntry;
    }
    // Oraclus's Prophecy of Doom (Death Pact #31 + Environmental Attack #2)
    // - same deferred pattern as divineJudgmentTriggerLogEntry just above,
    // fired from this same onAnyDeath dispatch (see oraclus.js's own
    // registration).
    if (anyDeathExtra?.prophecyOfDoomTriggerLogEntry) {
      result.prophecyOfDoomTriggerLogEntry = anyDeathExtra.prophecyOfDoomTriggerLogEntry;
    }
    // Melyssa's Friendship - the bond quietly ending because the FRIEND
    // (not Melyssa) just died to this hit. Same deferred pattern as
    // divineJudgmentTriggerLogEntry/prophecyOfDoomTriggerLogEntry above -
    // confirmed real bug, 2026-09-20 (see melyssa.js's own onAnyDeath
    // registration for the full reasoning/live symptom).
    if (anyDeathExtra?.friendshipEndLogEntry) {
      result.friendshipEndLogEntry = anyDeathExtra.friendshipEndLogEntry;
    }
    // Melyssa's Friendship - a redirected hit's own spillover entry (e.g.
    // Athena's Divine Judgment or Oraclus's Prophecy of Doom pact-kill
    // itself landing on a friended Melyssa and spilling over after the
    // friend can't fully absorb it) - same deferred pattern as
    // friendshipEndLogEntry directly above.
    if (anyDeathExtra?.friendshipSpilloverLogEntry) {
      result.friendshipSpilloverLogEntry = anyDeathExtra.friendshipSpilloverLogEntry;
    }
  }

  // onHitLanded dispatch (see engine/categories/onHitLanded.js): Melyssa's
  // reactive shield, Kaelis's grudge accumulation, and Athena's curse-mirror
  // all now live in their own ability files' registered callbacks - each
  // applies its own extra gating inside its own callback rather than here,
  // since those exclusions differ per-character (e.g. Athena's mirror must
  // still fire on the exact hit that just KO'd her - see her own
  // registration for why this call site is NOT gated on `!target.isKO` the
  // way it used to be; Melyssa/Kaelis's own callbacks each check isKO
  // internally instead, where that exclusion is actually meaningful for
  // them specifically). hitLandedCtxExtra carries anything an earlier
  // onOwnDeath callback handed forward this same call (see above).
  const hitLandedExtra = runOnHitLanded(target, game, log, {
    amountDealt: result.amountDealt, isMirror, isPoisonTick, isAshkaStrike, sourceCharacterId, ...hitLandedCtxExtra,
  });
  if (hitLandedExtra) Object.assign(result, hitLandedExtra);

  return result;
}

export function applyHeal(game, targetCharacterId, amount) {
  const target = game.characters[targetCharacterId];
  if (!target || target.isKO) return 0;
  const before = target.hearts;
  target.hearts = Math.min(target.maxHearts, target.hearts + amount);
  return target.hearts - before;
}

export function applyShield(game, targetCharacterId, amount, { decaying = false } = {}) {
  const target = game.characters[targetCharacterId];
  if (!target || target.isKO) return;
  // Rowan's Silence Lock blocks every shield source while active, not just
  // his special-ability lock - a silenced Athena/Tharox still casts Divine
  // Restore/Glory Smash normally (those aren't blocked by isLegal), but the
  // shield portion of it simply does nothing while silenced.
  if (isSilenced(target, game)) return;
  target.shield += amount;
  if (decaying) target.shieldDecaying = true;
}

// Called at the start of a character's own turn: decaying shields (Tharox
// Glory Smash, Athena Divine Restore) expire once that character's next
// turn begins, regardless of how many rounds/other players passed.
export function decayShieldIfDue(character) {
  if (character.shieldDecaying) {
    character.shield = 0;
    character.shieldDecaying = false;
  }
}

