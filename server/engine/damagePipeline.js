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
// Skull Crack headache) - deliberately excludes Blade's streak-lock and
// Kaelis's grudge count, since both are the ATTACKER's own tracked
// resource rather than a status placed ON the victim (same ruling already
// established for what Rowan's Purify treats as "urgent" vs. what it
// merely sweeps up as a side effect - see rowanHasUrgentNegativeStatus in
// botPlayer.js). Used by Marin's Clean Slate: both its reactive trigger
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

export function applyDamage(game, log, {
  sourceCharacterId,
  targetCharacterId,
  amount,
  ignoresShield = false,
  ignoresUntargetable = false,
  isMirror = false,
  isPoisonTick = false,
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

  // Untargetable is enforced primarily at the targeting UI layer; this is a
  // defensive re-check so a bug upstream can't sneak damage through.
  if (target.untargetable && !ignoresUntargetable) {
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
    amountDealt: result.amountDealt, isMirror, isPoisonTick, sourceCharacterId, heartsBefore,
  });
  if (earlyExtra) Object.assign(result, earlyExtra);

  // Rebirth (category-driven, see engine/categories/rebirthRegistry.js +
  // onOtherRevived.js): automatic, intercepts the KO the instant it would
  // happen. `rebirthResetter` looks up whichever character's own module
  // registered a Rebirth reset (currently only Blade) - `!target.special.
  // rebirthUsed` still gates it here rather than inside the resetter, since
  // "already used" is a universal one-shot Rebirth precondition, not
  // something specific to any one character's reset logic.
  const rebirthResetter = getRebirthResetter(target.id);
  if (rebirthResetter && target.hearts === 0 && !target.special.rebirthUsed && !ignoresRebirth) {
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
  } else if (target.id === 'draxus' && target.hearts === 0 && target.special.deathproofActive && !ignoresImmortal) {
    // Floors at 1 instead of KO - NOT a revival event (isKO is never set,
    // no "comes back fresh" cleanup like Rebirth's above, since he never
    // actually died: his hearts never truly reach/stay at 0). Deliberately
    // NOT flipped off here, unlike Blade's one-shot rebirthUsed - stays
    // active and re-triggers for every subsequent qualifying hit (any
    // source: direct attacks, curse mirrors, Jester Ball explosions, all
    // of which route through this same applyDamage) until his own
    // onTurnStart clears it (draxus.js), at the start of his own next turn.
    target.hearts = 1;
    result.deathproofSave = true;
  } else if (target.hearts === 0) {
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
      const { fowlPlayRevertLogEntry, ...rest } = ownDeathExtra;
      if (fowlPlayRevertLogEntry) result.fowlPlayRevertLogEntry = fowlPlayRevertLogEntry;
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
    runOnAnyDeath(target.id, sourceCharacterId, isMirror, game, log);
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
    amountDealt: result.amountDealt, isMirror, isPoisonTick, sourceCharacterId, ...hitLandedCtxExtra,
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

// Runs decayShieldIfDue for every character, BEFORE poison/silence/headache
// ticks fire this turn (see beginCharacterTurn in turnEngine.js). Without
// this, a decaying shield that expires on a character's own turn can be
// re-granted by that same turn's poison tick (Melyssa's reactive shield off
// Rowan's Poison Cloud) and then immediately wiped moments later by that
// character's own onTurnStart decay call, in the same beginCharacterTurn
// pass - the shield never provides any benefit. Running decay first means
// only a shield that was already stale from a PRIOR turn gets cleared here;
// anything granted during this turn's own tick sequence survives.
export function decayAllDueShields(game) {
  for (const character of Object.values(game.characters)) {
    decayShieldIfDue(character);
  }
}
