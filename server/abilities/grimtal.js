import { applyDamage, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { registerDodgeDefense } from '../engine/categories/dodgeDefenseRegistry.js';
import { makeSetupAction } from '../engine/categories/neutralAction.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnAnyDeath } from '../engine/categories/onAnyDeath.js';

// Grim Barrage: 4 independent random-target hits (raised from 3, confirmed
// ruling), 2 damage each - see the action definition below for the full
// reasoning.
const GRIM_BARRAGE_TOTAL_HITS = 4;
const GRIM_BARRAGE_DAMAGE_PER_HIT = 2;

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
// to receive credit.
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
        target.shield += 1;
        shielded += 1;
      }
    }
    log.push({ type: 'grim-ward-reward', targetCharacterId: target.id, healed, shielded });
  },
});

export const actions = {
  grimStrike: {
    label: 'Grim Strike',
    needsTarget: true,
    isLegal: () => true,
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
  // spells use (no separate hidden field needed).
  claimKill: makeSetupAction({
    label: 'Claim the Kill',
    actionId: 'claimKill',
    isLegal: (character) => character.special.unclaimedKillCount > 0,
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
    isLegal: (character) => character.special.skullCrackUsed < 3,
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
  // Grim Barrage: his desperation special (confirmed ruling), legal only
  // once he's genuinely on the brink (hearts <= 3 - same gate direction as
  // Tharox's Earthshatter/Illyra's Mirage Overload, a comeback move, not an
  // opener). No-target, one-time use, own dedicated usedGrimBarrage flag
  // (separate from usedSpecial, already spoken for by Skull Crack).
  //
  // 4 independent hits (raised from 3, confirmed ruling), each fully
  // independently random across every currently-alive OPPONENT (same "no
  // even split, no minimum-per-target guarantee" reasoning as
  // Earthshatter/Mirage Overload - a lopsided or single-target result,
  // even all 4 landing on one unlucky opponent, is completely normal, not
  // a bug). Modeled as separate hit EVENTS (not pre-aggregated damage
  // points like Earthshatter) since the headache-arming attempt needs to
  // be gated per hit. The FIRST hit that successfully arms the headache
  // wins and locks it in for the rest of the cast - later hits never
  // re-attempt or overwrite it, even if they themselves also land real
  // damage (confirmed ruling, corrected 2026-08-31 from an earlier "each
  // hit rolls independently" version, which let a later successful hit
  // silently overwrite an earlier one - live report: repeatedly never
  // seeing headache land from this move traced back to exactly this).
  //
  // Each hit is Environmental Attack (ignoresDodge: true, shield still
  // absorbs normally - NOT ignoresShield, unlike Skull Crack's own pierce
  // damage) - confirmed ruling, deliberately different shield interaction
  // from his normal-turn Skull Crack.
  grimBarrage: {
    label: 'Grim Barrage',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= 3 && !character.special.usedGrimBarrage,
    execute(character, targetId, game, log) {
      character.special.usedGrimBarrage = true;
      let others = Object.values(game.characters).filter((c) => c.id !== character.id && !c.isKO);
      const hits = [];
      // Confirmed ruling (2026-08-31, corrected from "each hit rolls
      // independently"): the FIRST hit in the sequence that successfully
      // arms the headache wins and locks it in for the rest of this cast -
      // no later hit, successful or not, re-attempts or overwrites it.
      // Without this, a later hit that dealt 0 damage (fully shield-
      // absorbed) or KO'd its target left the flags untouched (correct),
      // but a later hit that ALSO landed real damage on a valid target
      // would silently re-arm/overwrite an already-armed headache - not
      // wrong exactly, just not what was wanted: the first success should
      // be the one that counts, full stop.
      let headacheArmed = false;
      // First mid-cast Rebirth save (if any) - surfaced as the top-level
      // rebirthLogEntry return field, matching the single-field contract
      // finalizeAction() already checks for every other ability (see
      // turnEngine.js) - same fix as Earthshatter's own (2026-08-31). Same
      // reasoning extended to mirrorReflectLogEntry (Rowan's Mirror
      // Reflect, safe to capture only the first occurrence since it
      // self-deactivates the instant it fires - rowan.js's own
      // mirrorReflectActive = false) - each hit's own result already
      // carries these via the `...result` spread below, but finalizeAction
      // only ever reads them from the top-level return value, never from
      // inside an array element.
      //
      // Athena's curse-mirror needs full aggregation instead (mirrorTotal
      // below, not a single captured entry) - unlike Rebirth/Mirror
      // Reflect, her curse has no self-deactivating flag, so more than one
      // of Grim Barrage's up-to-4 hits landing on the cursed caster each
      // independently triggers a fresh mirror hit. Capturing only the
      // first silently dropped every subsequent mirror hit's damage from
      // the log line while the damage itself still correctly applied to
      // hearts - same real bug confirmed on Earthshatter's own identical
      // pattern (2026-09-01 live report), fixed here too for consistency.
      let rebirthLogEntry = null;
      let mirrorReflectLogEntry = null;
      let mirrorTotal = 0;
      let mirrorTargetId = null;
      let mirrorKoTriggered = false;
      let mirrorRevived = false;
      // Athena's Divine Judgment trigger - same "first occurrence wins" as
      // rebirthLogEntry/mirrorReflectLogEntry above (self-clears the
      // instant it fires, so only the first hit that triggers it can ever
      // matter). Added 2026-09-05, alongside the identical fix to Mirage
      // Burst (illyra.js) after the same gap was confirmed live there.
      let divineJudgmentTriggerLogEntry = null;
      for (let i = 0; i < GRIM_BARRAGE_TOTAL_HITS; i++) {
        if (others.length === 0) break;
        const target = others[Math.floor(Math.random() * others.length)];
        const result = applyDamage(game, log, {
          sourceCharacterId: character.id,
          targetCharacterId: target.id,
          amount: GRIM_BARRAGE_DAMAGE_PER_HIT,
          ignoresDodge: true,
          // Confirmed bug (2026-08-31, live report: "is grimtal barrage
          // not landing on velorya eclipse? it is environmental attack") -
          // Environmental Attack bypasses Untargetable entirely by
          // definition (same taxonomy rule Earthshatter/Mirage Burst
          // already follow), but this call was missing the flag - a hit
          // randomly landing on an untargetable target (e.g. Velorya
          // mid-Lunar Eclipse) silently no-op'd instead, wasting the swing.
          ignoresUntargetable: true,
        });
        // Same landed/blocked/headache-arming logic as Skull Crack's own
        // execute above, just repeated per hit instead of once - skipped
        // entirely once headacheArmed is already true. blockedBy names
        // WHICH mechanic actually fired (confirmed bug, 2026-09-01 - see
        // chronox.js's identical fix/comment on Time Freeze for the full
        // reasoning).
        let blockedBy = null;
        if (!headacheArmed && result.amountDealt > 0 && !result.koTriggered) {
          if (tryTriggerCleanSlate(target, game, log)) {
            blockedBy = 'cleanSlate';
          } else if (tryIllyraDodgeStatus(target, game, log, character.id)) {
            blockedBy = 'illyra';
          } else {
            character.special.headacheVictimId = target.id;
            character.special.headacheRollPending = true;
            headacheArmed = true;
          }
        }
        if (result.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.rebirthLogEntry;
        if (result.mirrorLogEntry) {
          mirrorTotal += result.mirrorLogEntry.amount;
          mirrorTargetId = result.mirrorLogEntry.toCharacterId;
          mirrorKoTriggered = result.mirrorLogEntry.koTriggered;
          mirrorRevived = result.mirrorLogEntry.revived;
        }
        if (result.mirrorResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorResult.rebirthLogEntry;
        if (result.mirrorReflectLogEntry && !mirrorReflectLogEntry) mirrorReflectLogEntry = result.mirrorReflectLogEntry;
        if (result.mirrorReflectResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorReflectResult.rebirthLogEntry;
        if (result.divineJudgmentTriggerLogEntry && !divineJudgmentTriggerLogEntry) divineJudgmentTriggerLogEntry = result.divineJudgmentTriggerLogEntry;
        hits.push({ targetId: target.id, blockedBy, ...result });
        // A hit that KO's its target removes them from the pool for any
        // REMAINING hits this same cast - confirmed ruling (2026-08-31,
        // live report: a 4-hit barrage killed Tharox on hit 1, then wasted
        // all 3 remaining hits re-rolling his already-dead body instead of
        // redirecting to Illyra, the only other living opponent). Tharox's
        // own Earthshatter has the same fix (2026-08-31) for the same
        // underlying reason.
        if (result.koTriggered) {
          others = others.filter((c) => c.id !== target.id);
        }
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'grimBarrage', hits });
      const mirrorLogEntry = mirrorTargetId
        ? {
          type: 'curse-mirror', fromCharacterId: 'athena', toCharacterId: mirrorTargetId,
          amount: mirrorTotal, koTriggered: mirrorKoTriggered, revived: mirrorRevived,
        }
        : null;
      return { hits, rebirthLogEntry, mirrorLogEntry, mirrorReflectLogEntry, divineJudgmentTriggerLogEntry };
    },
  },
};
