import { applyDamage, applyShield, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { registerDodgeDefense } from '../engine/categories/dodgeDefenseRegistry.js';
import { makeSetupAction } from '../engine/categories/neutralAction.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnAnyDeath } from '../engine/categories/onAnyDeath.js';

// Beast Attack's two discrete damage tiers (confirmed ruling, 2026-09-12,
// "high 3 low 2") - see the beastAttack action below for the full targeting
// rule.
const BEAST_ATTACK_HIGH_DAMAGE = 3;
const BEAST_ATTACK_LOW_DAMAGE = 2;

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - his own death
// ends Skull Crack's pending headache immediately, no one left to have
// caused it, same "caster's death cancels their own ongoing effects" rule
// as Rowan's poison/silence/mirror cleanup. Grim Ward simply stops
// mattering once he's dead (applyDamage's own isKO guard blocks any future
// hit from ever reading lastHitByThisCycle again), so no explicit clear
// needed for that part.
registerOnOwnDeath('grimtal', (character) => {
  character.special.headacheVictimId = null;
  character.special.headacheRollPending = false;
});

// Kill-credit bookkeeping (see engine/categories/onAnyDeath.js) - Grim
// Strike's damage is 1 + ownKillCount + claimedKillCount:
// - ownKillCount: KOs GRIMTAL HIMSELF personally lands (any of his attacks,
//   not just grimStrike) - increments automatically, no button needed.
// - claimedKillCount: KOs someone ELSE landed that Grimtal has since spent
//   a whole turn actively claiming via the Claim the Kill action (see
//   actions.claimKill below) - does NOT increment automatically just
//   because a death happened; unclaimedKillCount below is what banks up
//   waiting for that.
// isMirror excluded from the "his own kill" case for the same reasoning as
// every other attacker-attribution check in the codebase (a mirrored/
// reflected kill isn't a direct attack of his), but still banks as an
// unclaimed kill via the else branch (someone/something else's kill either
// way, from Grimtal's perspective). Fires on EVERY death in the game except
// his own (diedCharacterId !== 'grimtal') and only while he's alive himself
// to receive credit. Deliberately does NOT special-case a Beast Attack kill
// - confirmed ruling, 2026-09-12: "grimtal every condition save for later.
// but beast kill someone will not count it for grimtal" - a Beast Attack
// kill IS attributed via sourceCharacterId === 'grimtal' same as any other
// of his own kills, so without an explicit exclusion it WOULD bank toward
// ownKillCount. Handled instead by the beastForm reversion callback further
// down simply never reading/using ownKillCount/claimedKillCount for Beast
// Attack's own damage formula - the counters keep incrementing in the
// background exactly as they always did, they just have no bearing on
// beastAttack's fixed two-tier damage, and Grim Strike's own formula only
// ever matters again once he's back in human form anyway.
registerOnAnyDeath((diedCharacterId, sourceCharacterId, isMirror, game) => {
  if (diedCharacterId === 'grimtal') return;
  const grimtal = game.characters.grimtal;
  if (!grimtal || grimtal.isKO) return;
  // lastKillCreditSourceFor: remembers, PER VICTIM, WHICH POOL this most
  // recent KO credit is CURRENTLY sitting in - needed so a Resurrection
  // Gamble revival (Draxus's Cheat Death, taxonomy #32) can roll back the
  // exact counter it's actually in RIGHT NOW, not just where it started.
  // Confirmed bug, 2026-09-06 (found via a live match log): unclaimedKillCount
  // and claimedKillCount are anonymous/fungible pools, NOT tracked per-kill -
  // if Claim the Kill (actions.claimKill below) moves a unit from unclaimed
  // to claimed BEFORE Draxus revives, a rollback that only ever checks the
  // ORIGINAL 'unclaimed' tag would decrement the wrong (already-vacated)
  // pool, leaving the phantom credit sitting uncorrected in claimedKillCount
  // forever. Fixed by having claimKill's own mutate() update this map too,
  // flipping 'unclaimed' -> 'claimed' for whichever victim's credit it's
  // claiming (see claimKill below for how that victim is chosen from
  // multiple candidates) - so this map always reflects current location,
  // not just original source. Only ever consulted/cleared for 'draxus'
  // today (see the onOtherRevived rollback further below), but keyed
  // generically per-victim rather than hardcoded to him, in case a future
  // character gains a similar undo-my-own-death mechanic.
  if (sourceCharacterId === 'grimtal' && !isMirror) {
    grimtal.special.ownKillCount += 1;
    grimtal.special.lastKillCreditSourceFor = { ...grimtal.special.lastKillCreditSourceFor, [diedCharacterId]: 'own' };
  } else {
    grimtal.special.unclaimedKillCount += 1;
    grimtal.special.lastKillCreditSourceFor = { ...grimtal.special.lastKillCreditSourceFor, [diedCharacterId]: 'unclaimed' };
  }
});

// Beast Form reversion (Death-Triggered Reversion #36) - fires on EVERY
// death in the match, checked independently of who died or who dealt the
// killing blow. Confirmed ruling: "unless he can kill someone. or someone
// kill someone," clarified explicitly to mean ANY kill by ANY character
// reverts him, not just a kill he personally lands. Deliberately a SEPARATE
// registerOnAnyDeath callback from the kill-credit one above (different
// concern, both need to independently observe every death) - both still
// run on the same real KO event without conflict. Nothing here touches
// ownKillCount/claimedKillCount at all - they're exactly as they were the
// instant he transformed.
registerOnAnyDeath((diedCharacterId, sourceCharacterId, isMirror, game, log) => {
  const grimtal = game.characters.grimtal;
  if (!grimtal || !grimtal.special.beastFormActive) return;
  grimtal.special.beastFormActive = false;
  grimtal.untargetable = false;
  log.push({ type: 'beast-form-end', characterId: 'grimtal' });
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - his Skull
// Crack headache doesn't survive a target's own revival either, same
// "comes back fresh" reasoning - covers two distinct stale-state risks:
// (1) a pending, not-yet-rolled headache from before they died would
// otherwise still resolve on their reborn self's next turn, and (2) if the
// roll had ALREADY resolved to a skip before they died, their own
// skipHeadacheTurn flag would still be sitting true (that half is cleared
// on the revived character's OWN object, alongside their other own-state
// resets, not here - this callback only clears GRIMTAL's own tracking of
// them as a pending headache victim).
registerOnOtherRevived((revivedCharacterId, game) => {
  const grimtal = game.characters.grimtal;
  if (grimtal && grimtal.special.headacheVictimId === revivedCharacterId) {
    grimtal.special.headacheVictimId = null;
    grimtal.special.headacheRollPending = false;
  }
  // Resurrection Gamble rollback (Draxus's Cheat Death, taxonomy #32,
  // confirmed ruling 2026-09-06: "becareful grimtal have to give up his
  // death count for each alive count") - a KO Grimtal already banked
  // credit for (either ownKillCount, if HE landed it, or unclaimedKillCount,
  // if someone/something else did) must be given back the instant that
  // exact KO turns out not to have stuck after all. Only relevant for
  // Draxus specifically (the one character whose own death can currently
  // be undone this way) - every other onOtherRevived case in the game
  // today is Blade's Rebirth, which intercepts the killing blow BEFORE
  // isKO ever flips true, so runOnAnyDeath (and this credit) never fired
  // for it in the first place; this callback only needs to fire for a
  // GENUINE prior KO being undone after the fact.
  if (grimtal && !grimtal.isKO && revivedCharacterId === 'draxus') {
    const source = grimtal.special.lastKillCreditSourceFor?.draxus;
    if (source === 'own') {
      grimtal.special.ownKillCount = Math.max(0, grimtal.special.ownKillCount - 1);
    } else if (source === 'unclaimed') {
      grimtal.special.unclaimedKillCount = Math.max(0, grimtal.special.unclaimedKillCount - 1);
    } else if (source === 'claimed') {
      // Fixed 2026-09-06 (found via a live match log showing Claim the Kill
      // fire between his death and revival): the credit had already moved
      // out of unclaimedKillCount into claimedKillCount by the time this
      // fires - roll back THAT pool instead, since that's where it's
      // actually sitting right now (see claimKill's own mutate() above,
      // which keeps this map in sync with the credit's CURRENT location,
      // not just its original source).
      grimtal.special.claimedKillCount = Math.max(0, grimtal.special.claimedKillCount - 1);
    }
    if (grimtal.special.lastKillCreditSourceFor) delete grimtal.special.lastKillCreditSourceFor.draxus;
  }
});

// Grim Ward and the headache-roll from Skull Crack both need to run BEFORE
// the acting character's own legal-action set is computed, so they live in
// turnEngine.js's beginCharacterTurn instead of here (see resetGrimtalCycle/
// resolveHeadacheIfDue there) - onTurnStart only handles what's purely
// Grimtal's own bookkeeping.
export function onTurnStart(character, game, log) {
  // Grim Ward's per-cycle attacker tracking resets the instant HIS OWN turn
  // starts, not the victim's (he IS the victim here) - a fresh cycle begins
  // for whoever hits him from this point on.
  character.special.lastHitByThisCycle.clear();
}

// Dodge Defense category registration (see
// engine/categories/dodgeDefense.js) - additive, not yet consumed by
// applyDamage's own inline dodge block. Grim Ward: the FIRST attacker each
// cycle (since his own last turn ended) always lands; every DISTINCT
// attacker after that dodges (repeat hits from an attacker already recorded
// this cycle do NOT dodge again). The dodge check itself must run BEFORE
// recording this hit (matching the original inline block's own
// has()-before-add ordering exactly) - recordHit is kept as a separate hook
// (rather than folding the add() into consume()) because the original
// block adds the attacker to the cycle on BOTH the dodge and no-dodge
// paths, not only on a successful dodge.
registerDodgeDefense('grimtal', {
  canDodge(target, game, sourceCharacterId) {
    const cycle = target.special.lastHitByThisCycle;
    return cycle.size > 0 && !cycle.has(sourceCharacterId);
  },
  recordHit(target, game, sourceCharacterId) {
    target.special.lastHitByThisCycle.add(sourceCharacterId);
  },
  consume(target, game, sourceCharacterId, log) {
    const aliveCount = Object.values(game.characters).filter((c) => !c.isKO).length;
    const points = aliveCount >= 4 ? 2 : aliveCount === 3 ? 1 : 0;
    let healed = 0;
    let shielded = 0;
    for (let i = 0; i < points; i++) {
      if (target.hearts < target.maxHearts) {
        target.hearts += 1;
        healed += 1;
      } else {
        // Confirmed real bug, 2026-09-12: this used to do a raw
        // `target.shield += 1`, bypassing applyShield()'s own Rowan Silence
        // Lock check entirely - every other shield source in the game
        // (Athena, Tharox, Boingo, Zerathys, Chronox) correctly does
        // nothing while silenced, but this overflow-to-shield path silently
        // still worked. Routed through applyShield now for consistency -
        // non-decaying (matches this source's original always-permanent
        // behavior, no { decaying: true } option passed). applyShield
        // returns nothing, so `shielded` is measured from the real
        // before/after delta rather than assumed - a silenced Grimtal
        // correctly reports 0 shielded that point, not 1.
        const shieldBefore = target.shield;
        applyShield(game, target.id, 1);
        shielded += target.shield - shieldBefore;
      }
    }
    log.push({ type: 'grim-ward-reward', targetCharacterId: target.id, healed, shielded });
  },
});

export const actions = {
  grimStrike: {
    label: 'Grim Strike',
    needsTarget: true,
    // Hidden while beastFormActive (Death-Triggered Reversion #36) - his
    // entire normal kit is locked out in favor of the single synthetic
    // beastAttack action. isLegal returning false is enough on its own to
    // hide the button (same pattern every other conditionally-hidden action
    // in the game already uses), so no separate `hidden` flag is needed
    // here.
    isLegal: (character) => !character.special.beastFormActive,
    execute(character, targetId, game, log) {
      // ownKillCount: KOs he's personally landed (auto-incremented in
      // damagePipeline.js's KO branch). claimedKillCount: kills OTHERS
      // landed that he's since spent a turn actively claiming (see
      // claimKill below) - a banked, unclaimed kill contributes nothing
      // until claimed.
      const amount = 1 + character.special.ownKillCount + character.special.claimedKillCount;
      const result = applyDamage(game, log, { sourceCharacterId: character.id, targetCharacterId: targetId, amount });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grimStrike', targetId, ...result });
      return result;
    },
  },
  // Neutral Action (see engine/categories/neutralAction.js): transfers
  // between two counters, externally driven (unclaimedKillCount is banked
  // by OTHER characters' KO events elsewhere in applyDamage, not
  // self-initiated). Costs his entire turn (no attack this same turn) -
  // plain repeatable action, not his special (Skull Crack already holds
  // that slot). Legal only while there's an actual unclaimed kill banked -
  // the button disappears entirely once everything banked has been
  // claimed, same "hidden via isLegal alone" pattern Rowan's discoverable
  // spells use (no separate hidden field needed). Also hidden while
  // beastFormActive, same reasoning as grimStrike above.
  claimKill: makeSetupAction({
    label: 'Claim the Kill',
    actionId: 'claimKill',
    isLegal: (character) => !character.special.beastFormActive && character.special.unclaimedKillCount > 0,
    mutate(character) {
      character.special.unclaimedKillCount -= 1;
      character.special.claimedKillCount += 1;
      // Resurrection Gamble rollback tracking (taxonomy #32, fixed
      // 2026-09-06) - the unclaimed/claimed pools are anonymous/fungible
      // (no per-kill identity), so this can't know FOR CERTAIN which
      // specific banked victim's credit it just moved. Flips the oldest
      // still-'unclaimed'-tagged entry in lastKillCreditSourceFor to
      // 'claimed' as the best available approximation - correct whenever
      // only one kill is actually banked (the overwhelmingly common case,
      // since Claim the Kill's own isLegal already requires
      // unclaimedKillCount > 0 and most casts happen close to the kill
      // itself), and no worse than the pre-fix behavior (which didn't
      // track this at all) even in the rarer multi-banked-kill case.
      const src = character.special.lastKillCreditSourceFor;
      if (src) {
        const oldestUnclaimedId = Object.keys(src).find((id) => src[id] === 'unclaimed');
        if (oldestUnclaimedId) src[oldestUnclaimedId] = 'claimed';
      }
    },
  }),
  skullCrack: {
    label: 'Skull Crack',
    needsTarget: true,
    special: true,
    // 3 total casts per match - a plain counter (like Boingo's
    // jesterBallsUsed) rather than the shared usedSpecial boolean, since
    // that flag is read elsewhere as a flat "has the ONE special move been
    // used" signal and only flips true once all 3 are spent (see execute).
    // Also hidden while beastFormActive, same reasoning as grimStrike above.
    isLegal: (character) => !character.special.beastFormActive && character.special.skullCrackUsed < 3,
    execute(character, targetId, game, log) {
      character.special.skullCrackUsed += 1;
      if (character.special.skullCrackUsed >= 3) character.usedSpecial = true;
      // A normal targeted hit - dodgeable/reflectable by the target's own
      // mechanics (Akyros's dodge, Marin's Threefold Veil, etc.), same as
      // any other attack. ignoresShield: true is the one thing that makes
      // this "pierce" rather than a normal strike.
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 2,
        ignoresShield: true,
      });
      // Headache only takes hold if the hit actually landed (not dodged,
      // target didn't die from it - a KO'd character has no "next turn" to
      // roll against). One pending headache at a time is the natural
      // ceiling anyway: Skull Crack always targets someone and its own
      // isLegal has no extra gating, but overwriting a still-pending
      // headache on a DIFFERENT victim with a fresh one is fine (the old
      // victim just never gets their roll) since only ever the most recent
      // cast's victim matters once his own headacheVictimId is a single
      // slot, not a list - confirmed acceptable since a landed Skull Crack
      // is rare (one every several turns) and always the more recent
      // threat.
      //
      // Marin's Clean Slate: consumes/blocks the headache status itself,
      // same as Rowan's Silence Lock - the 2 pierce damage above still
      // lands normally regardless, only the headache side effect is
      // suppressed. blockedBy names WHICH mechanic actually fired
      // (confirmed bug, 2026-09-01 - see chronox.js's identical fix/
      // comment on Time Freeze for the full reasoning).
      let blockedBy = null;
      if (!result.dodged && result.amountDealt > 0 && !result.koTriggered) {
        const target = game.characters[targetId];
        // Illyra's passive checked alongside Clean Slate - same "50%
        // chance the STATUS side effect itself doesn't take" reasoning as
        // every other status-application site, independent of whatever
        // roll may have already applied to the 2 pierce damage above.
        if (tryTriggerCleanSlate(target, game, log)) {
          blockedBy = 'cleanSlate';
        } else if (tryIllyraDodgeStatus(target, game, log, character.id)) {
          blockedBy = 'illyra';
        } else {
          character.special.headacheVictimId = targetId;
          character.special.headacheRollPending = true;
        }
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'skullCrack', targetId, blockedBy, ...result });
      return result;
    },
  },
  // Beast Form (Death-Triggered Reversion #36, confirmed ruling 2026-09-12,
  // replaces the old Grim Barrage desperation special): hearts<=3, one-time
  // use, same gate direction as Tharox's Earthshatter/Illyra's Mirage
  // Overload (a comeback move, not an opener). No-target cast - this IS the
  // transformation itself, not an attack. While active (beastFormActive),
  // his entire normal kit is hidden (grimStrike/claimKill/skullCrack all
  // check this flag in their own isLegal above) in favor of the single
  // synthetic beastAttack action below. Untargetable is set directly here,
  // which alone already blocks every player-picked-target status/attack in
  // the game (isValidTarget rejects any untargetable character). Full
  // damage immunity is additionally enforced unconditionally inside
  // applyDamage itself (tryBeastFormImmunity, damagePipeline.js) to also
  // cover the few things with their own dedicated bypass-untargetable
  // mechanism (Fowl Play's chicken status, Melyssa's Full Control) - see
  // that function's own comment for the full boundary. Reverts to human
  // form the
  // instant ANY character anywhere is KO'd - see the registerOnAnyDeath
  // callback near the top of this file - NOT a fixed duration, NOT tied to
  // his own turns, NOT consumed specifically by his own successful kill
  // (any kill by anyone ends it).
  beastForm: {
    label: 'Beast Form',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= 3 && !character.special.usedBeastForm,
    execute(character, targetId, game, log) {
      character.special.usedBeastForm = true;
      character.special.beastFormActive = true;
      character.untargetable = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'beastForm' });
      return {};
    },
  },
  // Beast Attack: the ONLY action available while beastFormActive - a
  // fully normal Physical Attack (shield absorbs, dodge mechanics apply,
  // no bypass of any kind), manually targeted. Damage is entirely
  // independent of Grim Strike's own kill-count formula (confirmed ruling:
  // "grimtal every condition save for later. but beast kill someone will
  // not count it for grimtal") - two discrete tiers based on the TARGET's
  // current hearts, not his own stats: BEAST_ATTACK_HIGH_DAMAGE against
  // whoever currently holds the STRICTLY highest hearts among valid
  // targets, BEAST_ATTACK_LOW_DAMAGE against everyone else. A tie for
  // highest hearts defaults every tied character to the low tier, not the
  // high tier (confirmed ruling: "if multiple player same max health. then
  // also lower damage"). hidden: true keeps it out of the normal legal-
  // action listing on its own (mirrors Zerathys's soulSwapWrath) - it's
  // only ever surfaced by the client because it's the SOLE legal action
  // once beastFormActive is true (every other action's own isLegal returns
  // false), not because anything special-cases it into visibility.
  beastAttack: {
    label: 'Beast Attack',
    needsTarget: true,
    hidden: true,
    isLegal: (character) => !!character.special.beastFormActive,
    execute(character, targetId, game, log) {
      const others = Object.values(game.characters).filter((c) => c.id !== character.id && !c.isKO);
      const highestHearts = others.length > 0 ? Math.max(...others.map((c) => c.hearts)) : 0;
      const highestHolders = others.filter((c) => c.hearts === highestHearts);
      const isHighTier = highestHolders.length === 1 && highestHolders[0].id === targetId;
      const amount = isHighTier ? BEAST_ATTACK_HIGH_DAMAGE : BEAST_ATTACK_LOW_DAMAGE;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'beastAttack', targetId, isHighTier, ...result });
      return result;
    },
  },
};
