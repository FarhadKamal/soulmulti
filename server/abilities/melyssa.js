import { isSilenced, clearStatusesFromOneSource, heartsSnapshot, isFrozenByChronox } from '../engine/damagePipeline.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnAnyDeath } from '../engine/categories/onAnyDeath.js';

// Friendship's hearts<=3 gate (design-locked 2026-09-20, replaces Full
// Control - see project memory soulclash_melyssa.md for the full design
// history).
const FRIENDSHIP_HEARTS_THRESHOLD = 3;

// Self Choke's own flat damage (see server/index.js's executeSelfChoke) -
// duplicated here as a plain constant so isCurrentFriend-adjacent logic
// elsewhere can reason about "would choking my friend right now be lethal"
// without importing index.js (server/index.js is the top of the dependency
// graph, ability files sit below the engine layer which sits below it -
// importing back up would be circular).
export const SELF_CHOKE_DAMAGE = 2;

// True whenever Melyssa currently has an active Friendship bond - checked
// from several places (isValidTarget's mutual no-attack block, Mind
// Control's guaranteed-success passive, the redirect hook in
// damagePipeline.js). A null/undefined melyssaCharacter (not in this
// match, or somehow missing) safely returns false rather than throwing.
export function currentFriendId(game) {
  const melyssa = game.characters?.melyssa;
  if (!melyssa || melyssa.isKO) return null;
  return melyssa.special.friendCharacterId || null;
}

// True if `characterId` is Melyssa's current friend - used by
// isValidTarget/isValidPuppetTarget (block Melyssa/her puppets from
// targeting him) and by the reverse direction (block HIM from freely
// targeting Melyssa on his own turn - see turnEngine.js's own hook).
export function isCurrentFriend(game, characterId) {
  return currentFriendId(game) === characterId;
}

// True only for Melyssa herself, and only while she currently has an active
// Friendship bond - used by abilities whose harmful effect bypasses
// applyDamage entirely (direct state mutation, e.g. Velorya's Moonlit
// Theft stealing shield, same as Marin's Lifebond bypasses it for hearts),
// so damagePipeline.js's own redirect-to-friend hook never gets a chance to
// run. Confirmed ruling, 2026-09-21 (Moonlit Theft): rather than try to
// "redirect" a non-damage effect like a shield steal onto the friend (there
// is no single destination amount to redirect the way damage has), those
// abilities should just EXCLUDE her from their target pool entirely while
// bonded - a flat immunity, not a redirect. Deliberately only ever true for
// 'melyssa' herself - her friend's own shield/hearts stay completely normal,
// fully affectable targets for everyone else, same as anyone else's.
export function isProtectedByFriendship(game, characterId) {
  if (characterId !== 'melyssa') return false;
  return currentFriendId(game) !== null;
}

// Redirect helper for TARGETED, single-victim statuses that bypass
// applyDamage entirely (direct state mutation - e.g. Rowan's Silence Lock
// writing straight into silenceTargets) so damagePipeline.js's own
// redirect-to-friend hook never gets a chance to run for them, same
// structural gap Moonlit Theft/Shadow Seal had for their own AOE effects.
// Confirmed real bug, 2026-09-21 (live report: Rowan's Silence Lock landed
// directly on a friended Melyssa instead of redirecting to Velorya) - rule
// #3 ("any damage or status aimed at Melyssa redirects to the friend
// instead") was never actually true for ANY status that skips applyDamage,
// only for damage-shaped hits.
//
// Unlike Moonlit Theft/Shadow Seal's AOE-exclusion shape, a single-target
// status genuinely CAN be redirected the way damage is (there's exactly one
// destination to redirect to, same as a damage hit) - so this returns the
// FRIEND's id in place of the original targetId whenever a redirect should
// happen, for the caller to re-target its own single-victim state write
// with. Mirrors applyDamage's own redirect gate exactly: only fires when
// the original target actually IS Melyssa, she isn't KO'd, the source isn't
// Melyssa herself (her own puppeted casts on the friend are her own
// informed gamble, same exception damage redirect already has), and her
// friend is currently alive to receive it (no living friend - e.g. he just
// died this same cast - means the status simply lands on her directly, same
// "the bond can't protect her anymore" fallback damage redirect already
// has). Does NOT itself apply the status - callers still do their own
// eligibility/immunity checks (Clean Slate, Illyra's dodge, etc.) against
// whichever id this returns, exactly as they already do against the
// original targetId.
export function redirectStatusTargetIfProtected(game, targetId, sourceCharacterId) {
  if (targetId !== 'melyssa') return targetId;
  const melyssa = game.characters.melyssa;
  if (!melyssa || melyssa.isKO || sourceCharacterId === 'melyssa') return targetId;
  const friendId = melyssa.special.friendCharacterId;
  if (!friendId || friendId === sourceCharacterId) return targetId;
  const friend = game.characters[friendId];
  if (!friend || friend.isKO) return targetId;
  // Confirmed ruling, 2026-09-23: a frozen friend (Time Freeze/World Stops)
  // can't step in to redirect a status onto himself either - same reasoning
  // and same isFrozenByChronox check as applyDamage's own redirect gate in
  // damagePipeline.js. Imported lazily-by-reference is unnecessary here
  // since damagePipeline.js already exports it and melyssa.js already
  // imports several other named exports from that module.
  if (isFrozenByChronox(friend, game)) return targetId;
  return friendId;
}

// Slice 2 (design-locked 2026-09-20, implemented 2026-09-21): the friend
// cannot freely CHOOSE, on his own independent turn, any action that would
// also deal damage to or inflict a harmful status on Melyssa - confirmed
// ruling, re-stated directly after a live gap was found: "beast form is
// just example. you should ch[e]ck also other" - covers every AOE/global-
// status action in the roster, not just Beast Form. Deliberately does NOT
// apply when the SAME character is being puppeted by Melyssa herself into
// the action (see turnEngine.js's own isPuppeted parameter on
// getLegalActions) - that's her own informed gamble (confirmed ruling,
// walked through with Earthshatter as the illustrative example), not
// something the friend himself is choosing.
//
// One dedicated check per action, since each AOE/global-status ability has
// a genuinely different "who does this actually touch" shape - deliberately
// NOT a single generic "does actionId hit everyone" flag, since e.g.
// Moonlit Theft only matters if Melyssa currently HAS shield to steal, and
// Mirage Burst only matters if she's currently MARKED - a blanket block
// would needlessly hide the button in cases where it genuinely couldn't
// touch her at all this exact moment.
function wouldEndangerMelyssa(character, game, actionId) {
  const melyssa = game.characters.melyssa;
  if (!melyssa || melyssa.isKO || melyssa.id === character.id) return false;
  // Confirmed real bug caught before shipping: this whole restriction only
  // ever applies to Melyssa's CURRENT FRIEND specifically - without this
  // check, Earthshatter/World Stops/Fowl Play/Lifebond would be wrongly
  // blocked for EVERY character in the match any time Melyssa is alive,
  // bond or no bond, since those abilities always hit "every other living
  // character" regardless of any relationship to her.
  if (!isCurrentFriend(game, character.id)) return false;
  switch (actionId) {
    // Earthshatter (Tharox): random per-point damage across every OTHER
    // living character - always a real risk to her whenever she's alive
    // and not the caster (no narrower live condition to check, unlike the
    // shield/mark-gated ones below).
    case 'earthshatter':
      return true;
    // World Stops (Chronox): freezes every OTHER living character - a
    // harmful STATUS, not damage, but still blocked per the "any harmful
    // effect, damage or status" ruling.
    case 'worldStops':
      return true;
    // Fowl Play (Boingo): chickenifies every OTHER living character - same
    // "any harmful effect" reasoning as World Stops.
    case 'fowlPlay':
      return true;
    // Lifebond (Marin): averages hearts across EVERY living character,
    // caster included - blocked regardless of whether it would help or
    // hurt her this exact moment (confirmed ruling: "marin cannot cast
    // lifebond during that situation... even before" - no exemption for a
    // possibly-beneficial outcome).
    case 'lifebond':
      return true;
    // Moonlit Theft (Velorya): drains shield from every OTHER living
    // character - only a real risk to her if she currently HAS shield to
    // lose; a shieldless Melyssa has nothing this action could take.
    case 'moonlitTheft':
      return melyssa.shield > 0;
    // Mirage Burst (Illyra): detonates every character CURRENTLY carrying
    // a live mirage-mark stack - only a real risk to her if she's
    // currently marked.
    case 'mirageBurst': {
      const illyra = game.characters.illyra;
      const stacks = illyra?.special?.mirageMarks?.get('melyssa') || 0;
      return stacks > 0;
    }
    // Beast Form (Grimtal): no direct damage/status at all - blocked for a
    // completely different reason (identity-breaking, not endangerment -
    // see the dedicated isBeastFormBlockedByFriendship export below,
    // deliberately NOT folded into this function since the "why" is
    // structurally different from every case above).
    default:
      return false;
  }
}

// Beast Form's own restriction - separate from wouldEndangerMelyssa above
// since the reasoning is different (identity-breaking, not "this would
// hurt her"). Grimtal can never freely choose to transform on his own
// turn while friended; puppeted by Melyssa herself, it's allowed (and
// immediately ends the bond - see grimtal.js's own beastForm.execute()).
export function isBeastFormBlockedByFriendship(character, game) {
  return isCurrentFriend(game, character.id);
}

// Single entry point turnEngine.js's getLegalActions calls for every
// action, regardless of which of the 7 it is - keeps the ability-specific
// branching contained to this one file rather than scattered across the
// engine layer.
export function isActionBlockedByFriendship(character, game, actionId) {
  if (actionId === 'beastForm') return isBeastFormBlockedByFriendship(character, game);
  return wouldEndangerMelyssa(character, game, actionId);
}

// Ends the bond and reverts everything to normal - shared by the 2
// DIRECT-call break paths (voluntary/forced Self Choke, Beast Form
// transformation - both call this synchronously from their own execute(),
// AFTER their own triggering log entry already exists, so pushing directly
// to `log` there is correct). The THIRD path (the friend dying to someone
// ELSE - see registerOnAnyDeath below) does NOT call this function - it
// can't safely push to `log` at all from inside that callback (see its own
// comment for why), so it duplicates just the state-clearing half inline
// and defers its own log entry instead. Deliberately does NOT touch
// usedFriendship (stays permanently spent, matching every other one-time
// special once cast) or re-open the button - Friendship is truly one-time,
// breaking it is not "undoing the cast."
export function endFriendship(melyssa, game, log) {
  const friendId = melyssa.special.friendCharacterId;
  if (!friendId) return;
  melyssa.special.friendCharacterId = null;
  log.push({ type: 'friendship-end', characterId: 'melyssa', friendCharacterId: friendId, hearts: heartsSnapshot(game) });
}

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - Melyssa's OWN
// death (rule: "friend is freed instantly" - her own onOwnDeath fires when
// SHE is the one KO'd) - just clears friendCharacterId; there's no
// "friend" left to notify since the mutual no-attack/redirect checks all
// key off currentFriendId(game), which naturally reads null once this
// runs. No log entry needed here - her own KO already gets its own line
// from whatever killed her.
registerOnOwnDeath('melyssa', (character) => {
  character.special.friendCharacterId = null;
});
// The FRIEND's own death (rule 11: "friend dies to someone else, bond
// quietly ends") - registered generically below for every character, not
// just Melyssa, since we don't know in advance who her friend will be.
// Confirmed ruling, 2026-09-20: this also covers Draxus's Cheat Death (a
// genuine KO-then-later-revive, unlike Blade's Rebirth which intercepts
// BEFORE a real KO ever happens and so naturally never reaches this hook
// at all - the bond surviving Rebirth is a direct, accepted consequence of
// Rebirth's own interception timing, not special-cased here).
//
// Confirmed REAL bug, 2026-09-20: this callback fires SYNCHRONOUSLY, deep
// inside whatever applyDamage call actually killed the friend (Grimtal's
// own onAnyDeath/onOwnDeath registrations, and every other deferred-entry
// site in this codebase - Rebirth, Athena's curse-mirror, Divine Judgment,
// Prophecy of Doom, Fowl Play's revert - all hit this exact same trap and
// needed the same fix) - it runs BEFORE the triggering action's own caller
// has pushed ITS OWN log entry yet. Pushing 'friendship-end' directly here
// (as an earlier version of this code did) landed it BEFORE the real
// killing blow's own line in the log - confirmed live: "The Friendship
// bond... has ended" appeared with no visible cause, because the actual
// killing hit's own entry (e.g. a poison tick fired from
// getActingCharacterId's own beginCharacterTurn call, which pushes
// directly to game.log) hadn't been pushed yet at the point this callback
// ran. Fixed the same way every other entry in this position already is:
// clear the state here (safe, no log dependency), but DEFER the log entry
// itself via the return value - damagePipeline.js's own onAnyDeath
// dispatch call site merges it onto `result.friendshipEndLogEntry`, and
// every call site that already pushes divineJudgmentTriggerLogEntry/
// prophecyOfDoomTriggerLogEntry AFTER its own triggering line now pushes
// this one the same way.
registerOnAnyDeath((diedCharacterId, sourceCharacterId, isMirror, game, log) => {
  const melyssa = game.characters.melyssa;
  if (!melyssa || melyssa.isKO) return undefined;
  const friendId = melyssa.special.friendCharacterId;
  if (friendId !== diedCharacterId) return undefined;
  melyssa.special.friendCharacterId = null;
  const entry = { type: 'friendship-end', characterId: 'melyssa', friendCharacterId: friendId, hearts: heartsSnapshot(game) };
  return { friendshipEndLogEntry: entry };
});

// Guaranteed puppet control (confirmed ruling: "melyssa can even controll
// with 100% chance on her friends ability") - scoped SPECIFICALLY to
// puppeting her current friend, not a whole-board passive the way the old
// Full Control's hearts<=3 guarantee was. Mind Control's normal 50% resist
// chance (turnEngine.js's executeActionAsPuppet) is removed entirely only
// for this one specific puppet; every other character she puppets still
// rolls the normal 50/50. Exported so executeActionAsPuppet can check it
// without a circular import (melyssa.js already sits below turnEngine.js
// in the dependency direction - ability files import FROM the engine,
// never the reverse).
export function hasGuaranteedMindControl(melyssaCharacter, puppetCharacterId) {
  return !!melyssaCharacter && !melyssaCharacter.isKO
    && melyssaCharacter.special.friendCharacterId === puppetCharacterId;
}

// Reactive shield (see engine/categories/onHitLanded.js): whenever damage
// actually reaches her hearts (ctx.amountDealt - already reduced by
// absorption for a normal hit, or the full raw amount for an ignoresShield
// hit since those skip absorption entirely), she gains new shield EXACTLY
// equal to that leaked-through amount, REPLACING whatever shield she had
// left (not additive). Reuses the same decaying:true persistence Tharox/
// Athena already have (clears via decayShieldIfDue, run at the very start
// of HER OWN beginCharacterTurn - BEFORE this turn's own poison tick, so a
// shield granted by a poison tick landing on her own turn survives instead of
// being wiped moments later). Confirmed bug fix, 2026-09-11: this decay used
// to run for EVERY character on every beginCharacterTurn call, not just the
// shield-holder's own turn - see turnEngine.js's beginCharacterTurn. Fires even when amountDealt
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
  // Boingo's Fowl Play - confirmed ruling: "NO SHIELD... during chicken
  // status" extends to shield GENERATION too, not just shield blocking
  // damage - a chickenified Melyssa must not gain any reactive shield at
  // all (confirmed bug, 2026-09-04, live report: a match log showed
  // "Melyssa:2+1sh" while she was still a chicken). applyDamage's own
  // target.isChicken bypass already makes any shield she'd have pointless
  // against a FUTURE chicken attack, but this passive fires unconditionally
  // regardless of what hit her, so it needs its own explicit guard rather
  // than relying on that downstream bypass alone.
  if (character.isChicken) return;
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
  // Friendship (design-locked 2026-09-20, replaces Full Control): one-time
  // hearts<=3 special. Picks any other living, non-frozen, non-untargetable
  // character (same eligibility as Mind Control's own target pool - no
  // ally/enemy restriction, since this game has no teams) and forms a bond:
  // neither can attack the other (turnEngine.js's isValidTarget/
  // isValidPuppetTarget), Mind Control on the friend specifically becomes
  // 100% guaranteed for the rest of the match (hasGuaranteedMindControl,
  // scoped to just this one puppet - every OTHER character she puppets
  // still rolls the normal 50/50), and any damage/status that would land
  // on Melyssa
  // redirects to the friend instead (with hearts-based spillover - see
  // damagePipeline.js's applyDamage redirect hook). Retroactively cleanses
  // whatever negative status the NEW friend had already inflicted on her
  // before the bond formed (confirmed ruling: "if athena casted judgement
  // strike or curse strike to melyssa... now melyssa cast friendship of
  // athena... melyssa's judgement strike or curse status will remove" -
  // scoped to just that one source, see clearStatusesFromOneSource).
  friendship: {
    label: 'Friendship',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.hearts <= FRIENDSHIP_HEARTS_THRESHOLD && !character.special.usedFriendship,
    execute(character, targetId, game, log) {
      character.special.usedFriendship = true;
      character.special.friendCharacterId = targetId;
      clearStatusesFromOneSource(character, game, log, targetId);
      log.push({ type: 'special', characterId: character.id, actionId: 'friendship', targetId, hearts: heartsSnapshot(game) });
      return {};
    },
  },
};

// Friendship's own target-eligibility rule (same shape as Mind Control's
// own isValidMindControlTarget in turnEngine.js, minus a circular import -
// melyssa.js sits below turnEngine.js in the dependency graph, so this is
// a self-contained reimplementation rather than an import). Exported so
// turnEngine.js's own isValidTarget can dispatch to it for the
// 'friendship' actionId specifically.
export function isValidFriendshipTarget(game, targetId) {
  const target = game.characters[targetId];
  if (!target || target.id === 'melyssa') return false;
  if (target.isKO || target.untargetable || target.skipNextTurn) return false;
  return true;
}
