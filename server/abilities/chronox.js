import { applyDamage, isSilenced, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { flipCoin } from '../engine/random.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnHitLandedEarly } from '../engine/categories/onHitLandedEarly.js';

// Rewind pending-snapshot drift correction (see
// engine/categories/onHitLandedEarly.js): his snapshot
// (special.lastActionAgainstMe.chronoxSnapshot.hearts) is captured at some
// point in the PAST - the moment right before whichever action is
// currently the "most recent action against him." If damage lands on him
// from a source that ISN'T that recorded action (poison ticks, a
// curse-mirror bounce, Mirror Reflect's counter-hit, anything not routed
// through the normal recording flow), the snapshot itself must shift down
// by that same amount too - otherwise Rewind would restore him past damage
// it was never meant to touch, i.e. free healing for damage from an
// unrelated source.
//
// EXCLUDED: damage from the SAME caster+turnInstance as the currently
// pending record - this is a chained follow-up within the same combo
// (Soul Swap's soulSwapWrath, Draxus's bonus strikes), and that damage
// genuinely SHOULD be absorbed into the existing snapshot's own
// before-state, not corrected away as "unrelated." mindControl (Melyssa's
// puppet SELECTION step) is excluded from combo continuation too - a
// pending mindControl record's snapshot must still drift-correct against
// any damage that follows in the same turn (e.g. Self Choke), not be
// treated as "part of the same combo" and skipped. Matches the same
// turnInstance-based combo detection turnEngine.js's
// buildActionAgainstChronoxRecord already uses.
registerOnHitLandedEarly('chronox', (character, game, log, ctx) => {
  const record = character.special?.lastActionAgainstMe;
  if (!record) return;
  const isSameComboContinuation = record.casterId === ctx.sourceCharacterId
    && game.turnInstanceFor?.get(ctx.sourceCharacterId) === record.casterTurnInstance
    && record.actionId !== 'mindControl';
  if (isSameComboContinuation) return;
  const drift = ctx.heartsBefore - character.hearts;
  if (drift > 0) {
    record.chronoxSnapshot.hearts = Math.max(0, record.chronoxSnapshot.hearts - drift);
  }
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - 3 separate
// stale-reference risks, all against the now-revived character specifically.
registerOnOtherRevived((revivedCharacterId, game) => {
  const chronox = game.characters.chronox;
  if (!chronox) return;
  // Time Freeze doesn't just set skipNextTurn once - it's re-applied on
  // CHRONOX's own next turn via freezeActive/freezeTargetId (see this
  // file's own onTurnStart), which has no awareness that its target died
  // and came back in between. Ending the freeze here matches "comes back
  // fresh with no negative energy."
  if (chronox.special.freezeActive && chronox.special.freezeTargetId === revivedCharacterId) {
    chronox.special.freezeActive = false;
    chronox.special.freezeTargetId = null;
  }
  // World Stops equivalent - removes the revived character alone from the
  // shared frozen group rather than ending the whole thing for everyone
  // else still frozen.
  if (chronox.special.worldStopsActive && chronox.special.worldStopsFrozenIds?.has(revivedCharacterId)) {
    chronox.special.worldStopsFrozenIds.delete(revivedCharacterId);
    if (chronox.special.worldStopsFrozenIds.size === 0) {
      chronox.special.worldStopsActive = false;
    }
  }
  // A Rewind snapshot must be invalidated if IT was recorded against this
  // now-revived character as the caster - otherwise casting Rewind later
  // would restore a STALE pre-death snapshot of them, silently erasing
  // their revival entirely (their hearts revert to whatever they were
  // before the fatal hit, their own "used" flag reverts to false, letting
  // them "die and revive" a second time for free). Confirmed live-reasoning
  // gap: isLegal's own "caster still alive" check doesn't catch this, since
  // the revival flips isKO straight back to false - the caster looks alive
  // again by the time Rewind is cast, even though the snapshot itself now
  // predates a death/revival it knows nothing about.
  if (chronox.special.lastActionAgainstMe?.casterId === revivedCharacterId) {
    chronox.special.lastActionAgainstMe = null;
  }
});

// KO-branch cleanup (see engine/categories/onOwnDeath.js).
registerOnOwnDeath('chronox', (character, game, log) => {
  // Time Freeze ends immediately if he's KO'd - no one left to keep
  // re-applying the skip each round, so the frozen target is freed rather
  // than being stuck frozen with no way for it to ever lift.
  if (character.special.freezeActive) {
    const frozenId = character.special.freezeTargetId;
    const frozen = game.characters[frozenId];
    if (frozen) frozen.skipNextTurn = false;
    character.special.freezeActive = false;
    character.special.freezeTargetId = null;
    log.push({ type: 'freeze-end', targetCharacterId: frozenId });
  }
  // Same reasoning for World Stops - frees the WHOLE group at once, unlike
  // Blade's own Rebirth cleanup (which only removes Blade himself from an
  // otherwise-still-live group) - Chronox dying ends the effect entirely
  // for everyone in it.
  if (character.special.worldStopsActive) {
    const frozenIds = [...character.special.worldStopsFrozenIds];
    for (const frozenId of frozenIds) {
      const frozen = game.characters[frozenId];
      if (frozen) frozen.skipNextTurn = false;
    }
    character.special.worldStopsActive = false;
    character.special.worldStopsFrozenIds = new Set();
    log.push({ type: 'world-stops-end', frozenIds });
  }
  // His own death ends any pending Rewind opportunity and lockout
  // immediately - not strictly load-bearing today (he has no revival
  // mechanic, and applyDamage's own isKO guard blocks any future action
  // from ever targeting a dead Chronox), but matches the same defensive
  // "caster's death cancels their own state" cleanup every other character
  // gets, in case a future mechanic ever revives him.
  character.special.lastActionAgainstMe = null;
  character.special.lockedActionCasterId = null;
  character.special.lockedActionId = null;
  character.special.lockedActionTurnsRemaining = 0;
});

// Total rounds World Stops' freeze lasts (confirmed ruling - 4, doubled
// from an initial 2). Round 1 is applied immediately at cast time
// (worldStops.execute sets skipNextTurn + worldStopsSkipsApplied = 1);
// this constant gates the remaining continuation ticks in onTurnStart
// below, so the group is frozen for this many of their own turns total.
const WORLD_STOPS_TOTAL_ROUNDS = 4;

export function onTurnStart(character, game, log) {
  // Chrono Guard: shield RESETS to exactly 1 each turn - does not stack.
  // Rowan's Silence Lock suppresses this entirely while active (blocks
  // every shield source, not just special abilities) - a silenced Chronox
  // gets 0 here instead of the usual reset-to-1.
  if (isSilenced(character, game)) {
    character.shield = 0;
  } else {
    character.shield = 1;
    log.push({ type: 'passive', characterId: character.id, text: `${character.id}'s shield resets to 1 (Chrono Guard)` });
  }

  // Time Freeze: flat 2-round duration, no coin flip. Casting already skips
  // the target's next turn (round 1); this extends it for 1 more round,
  // then ends automatically.
  if (character.special.freezeActive) {
    const frozenId = character.special.freezeTargetId;
    if (character.special.freezeSkipsApplied < 2) {
      const frozen = game.characters[frozenId];
      if (frozen && !frozen.isKO) frozen.skipNextTurn = true;
      character.special.freezeSkipsApplied += 1;
      log.push({ type: 'freeze-continue', targetCharacterId: frozenId });
    } else {
      character.special.freezeActive = false;
      character.special.freezeTargetId = null;
      log.push({ type: 'freeze-end', targetCharacterId: frozenId });
    }
  }

  // World Stops: flat 4-round duration (confirmed ruling, raised from an
  // initial 2 - double Time Freeze's own duration, matching the scale of
  // freezing everyone at once rather than a single target), a single
  // SHARED countdown re-applied to the whole frozen group together each
  // tick rather than per-target - simpler, and the group was locked in at
  // cast time (worldStopsFrozenIds), so it's stable even if someone in the
  // group is later KO'd by something else (the `!frozen.isKO` guard just
  // skips re-applying to them, no error).
  if (character.special.worldStopsActive) {
    if (character.special.worldStopsSkipsApplied < WORLD_STOPS_TOTAL_ROUNDS) {
      for (const frozenId of character.special.worldStopsFrozenIds) {
        const frozen = game.characters[frozenId];
        if (frozen && !frozen.isKO) frozen.skipNextTurn = true;
      }
      character.special.worldStopsSkipsApplied += 1;
      log.push({ type: 'world-stops-continue', frozenIds: [...character.special.worldStopsFrozenIds] });
    } else {
      character.special.worldStopsActive = false;
      character.special.worldStopsFrozenIds = new Set();
      log.push({ type: 'world-stops-end' });
    }
  }
}

export const actions = {
  cyclonePunch: {
    label: 'Cyclone Punch',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      character.special.hasActedOnce = true;
      const flip = flipCoin();
      const amount = flip === 'heads' ? 2 : 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'cyclonePunch', targetId, flip, ...result });
      return result;
    },
  },
  timeFreeze: {
    label: 'Time Freeze',
    needsTarget: true,
    special: true,
    // Not available on his very first turn - user-requested delay so he
    // can't open the match with an immediate freeze before anyone else has
    // even had a turn. Same hasActedOnce pattern as Velorya's Moonstep.
    isLegal: (character) => !character.usedSpecial && character.special.hasActedOnce,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      character.special.hasActedOnce = true;
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the freeze itself - the cast
      // still spends his special, it just never actually freezes her.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId, blocked: true });
        return { targetCharacterId: targetId };
      }
      // Illyra's passive: a 50% chance the freeze itself simply doesn't
      // take - the cast still spends his special either way, same
      // reasoning as the Clean Slate case above.
      if (tryIllyraDodgeStatus(target, game, log, character.id)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId, blocked: true });
        return { targetCharacterId: targetId };
      }
      character.special.freezeActive = true;
      character.special.freezeTargetId = targetId;
      character.special.freezeSkipsApplied = 1;
      if (target) target.skipNextTurn = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId });
      return { targetCharacterId: targetId };
    },
  },
  // World Stops: his desperate last-stand special (confirmed ruling) -
  // one-time use, legal only once he's genuinely on the brink (hearts <= 3,
  // same gate direction as Illyra's Mirage Overload/Tharox's Earthshatter -
  // NOT the hasActedOnce gate Time Freeze uses). No-target: freezes every
  // currently-alive opponent at once, same flat 2-round skip shape as Time
  // Freeze but with one SHARED countdown for the whole group (see
  // onTurnStart above). Confirmed ruling on resist mechanics: bypasses
  // dodge (Akyros/Marin's veil/Grimtal/Illyra's passive), untargetable
  // (Velorya's Lunar Eclipse), AND Illyra's own 50% status-resist - none of
  // those are checked here at all. The ONE exception that still works
  // against it is Marin's Clean Slate (confirmed ruling) - she alone can
  // still block the frozen status on herself.
  worldStops: {
    label: 'World Stops',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= 3 && !character.special.usedWorldStops,
    execute(character, targetId, game, log) {
      character.special.usedWorldStops = true;
      const opponents = Object.values(game.characters).filter((c) => c.id !== character.id && !c.isKO);
      const frozenIds = [];
      const blockedIds = [];
      for (const opponent of opponents) {
        if (tryTriggerCleanSlate(opponent, game, log)) {
          blockedIds.push(opponent.id);
          continue;
        }
        opponent.skipNextTurn = true;
        frozenIds.push(opponent.id);
      }
      character.special.worldStopsActive = frozenIds.length > 0;
      character.special.worldStopsFrozenIds = new Set(frozenIds);
      character.special.worldStopsSkipsApplied = 1;
      log.push({ type: 'special', characterId: character.id, actionId: 'worldStops', frozenIds, blockedIds });
      return { frozenIds, blockedIds };
    },
  },
  rewind: {
    label: 'Rewind',
    // No-target: always resolves against whoever caused
    // special.lastActionAgainstMe, there's only ever one valid choice
    // (same "no target picker needed" reasoning as Grimtal's Claim the
    // Kill/Illyra's Mirage Burst).
    needsTarget: false,
    // Own dedicated counter (rewindUsesRemaining), NOT the shared usedSpecial
    // boolean - Time Freeze already owns that one, and overloading it here
    // would incorrectly also lock out Time Freeze (or vice versa) the
    // moment either was cast, same reasoning as every other multi-special
    // character in the roster (Rowan's usedSpells Set, Boingo's
    // jesterBallsUsed counter, Grimtal's skullCrackUsed counter). Usable
    // twice per match.
    special: true,
    isLegal: (character, game) => {
      if (character.special.rewindUsesRemaining <= 0) return false;
      const record = character.special.lastActionAgainstMe;
      if (!record) return false;
      // Jester Ball explosions record no caster at all (see
      // turnEngine.js's resolveJesterBall) - always legal to undo, there's
      // no "attacker" who could have died to make it moot.
      if (record.casterId === null) return true;
      const caster = game.characters[record.casterId];
      // Confirmed ruling: illegal if the qualifying attacker has since
      // died - his one precious use is preserved for a real future
      // opportunity rather than being wasted refunding a move that's now
      // moot (though he'd still get his own hearts/shield back either way
      // in principle, the ruling was explicitly "illegal," not "still
      // works, refund wasted").
      return !!caster && !caster.isKO;
    },
    execute(character, targetId, game, log) {
      character.special.rewindUsesRemaining -= 1;
      const rewindUsesRemaining = character.special.rewindUsesRemaining;
      const record = character.special.lastActionAgainstMe;
      // Jester Ball explosions record no caster at all (see turnEngine.js's
      // resolveJesterBall's own comment for the full reasoning) - there's
      // no character object to restore, and deliberately no lockout set
      // afterward either (there's no clean "can't do this exact move
      // again" concept for a shared ball with no single decision-maker).
      // Just undo Chronox's own damage and put the ball back in play.
      if (record.casterId === null) {
        // Same "Chronox's own one-time-use flags must survive this
        // restore" protection as the normal (non-null-caster) branch below
        // - see its own comment for why. A Jester Ball explosion is still
        // just an attack landing on him, same reachability argument.
        const usedSpecialNoCaster = character.usedSpecial;
        const usedWorldStopsNoCaster = character.special.usedWorldStops;
        Object.assign(character, structuredClone(record.chronoxSnapshot));
        character.special.rewindUsesRemaining = rewindUsesRemaining;
        character.usedSpecial = usedSpecialNoCaster;
        character.special.usedWorldStops = usedWorldStopsNoCaster;
        if (record.jesterBallSnapshot !== undefined) {
          game.jesterBall = structuredClone(record.jesterBallSnapshot);
        }
        character.special.lastActionAgainstMe = null;
        log.push({
          type: 'special', characterId: character.id, actionId: 'rewind',
          rewoundCasterId: null, rewoundActionId: record.actionId,
        });
        return {};
      }
      const caster = game.characters[record.casterId];
      // Restoring the CASTER's and CHRONOX's entire character objects
      // wholesale (not a hand-computed diff) is what makes this correct
      // for every possible effect type in the game uniformly - it
      // automatically refunds whatever limited-use tracking field that
      // action touched (usedSpecial, skullCrackUsed, jesterBallsUsed,
      // usedSpells, etc.) as a side effect of restoring the WHOLE object,
      // undoes any status the action placed (curse/freeze/mark/silence/
      // headache/mirageMarks all live on the caster's own special),
      // reverses Soul Swap's heart-swap (both sides' hearts are part of
      // the restored objects), and restores Illyra's stack count that a
      // Mirage Burst zeroed out. rewindUsesRemaining (decremented above,
      // AFTER the snapshot was taken) must survive this restore, since it's
      // never part of the snapshot's own prior state.
      // Melyssa's Mind Control lifecycle flags need the same "survive the
      // restore" treatment, for a different reason: her snapshot is always
      // taken MID-turn, while special.controlling is still true (Self
      // Choke doesn't route through executeAction, so
      // recordActionAgainstChronoxIfApplicable fires from inside
      // executeSelfChoke, before finishMelyssaTurn/finishBotMindControlTurn
      // ever clears controlling/puppetCharacterId back to false/null).
      // Restoring her whole object wholesale would resurrect that stale
      // "still mid-control" state even though her turn had genuinely
      // already ended by the time Rewind was cast - confirmed live as a
      // stuck mind-control glow/portrait on Chronox that never cleared.
      // Only relevant when Melyssa herself is the rewound caster; harmless
      // no-op (both undefined) for every other character.
      const controlling = caster.special.controlling;
      const puppetCharacterId = caster.special.puppetCharacterId;
      // Draxus's Deathless Fury window flag needs the same "survive the
      // restore" treatment, for the same underlying reason - Melyssa can
      // puppet him into attacking Chronox WHILE deathproofActive is still
      // true (his own onTurnStart, which normally clears it, only fires on
      // HIS turn, so a puppeted mid-window attack is genuinely reachable
      // even though he can never do this on his own). If his window later
      // ends normally (his own onTurnStart clears deathproofActive and
      // grants the 3-hit bonus turn) before Chronox gets around to
      // Rewinding that old puppeted hit, restoring the stale snapshot would
      // flip deathproofActive back to true - re-arming an already-spent
      // Deathless Fury, granting a completely unearned SECOND bonus turn
      // the next time his onTurnStart runs. Confirmed reachable via direct
      // reproduction. Preserve the CURRENT live value instead; harmless
      // no-op (undefined) for every other character.
      //
      // bonusActionsRemaining is deliberately NOT given this same
      // treatment - unlike deathproofActive, restoring IT from the
      // snapshot is the correct behavior: the snapshot is always taken
      // before a bonus-turn combo's strikes begin consuming it (see the
      // turnInstance "same combo" guard in recordActionAgainstChronoxIfApplicable),
      // so restoring it un-consumes exactly the strikes Rewind is undoing.
      const deathproofActive = caster.special.deathproofActive;
      // Chronox's OWN one-time-use flags (usedSpecial for Time Freeze,
      // usedWorldStops for World Stops) must survive this restore too, for
      // a different reason than the caster-side fields above: this record
      // is always an attack AGAINST Chronox (buildActionAgainstChronoxRecord
      // requires targetId === 'chronox' - he can never be his own recorded
      // caster here), so there is no "rewind my own cast to refund it"
      // scenario reachable through this path. Without this, restoring an
      // old chronoxSnapshot silently rolls his already-legitimately-spent
      // specials back to whatever they were at that earlier snapshot
      // moment - confirmed live/reachable: rewinding an attacker's hit that
      // happened to predate his own first World Stops cast let him cast it
      // a second time later in the same match, even though hearts <= 3 was
      // independently, separately satisfied both times by real damage.
      const usedSpecial = character.usedSpecial;
      const usedWorldStops = character.special.usedWorldStops;
      Object.assign(caster, structuredClone(record.casterSnapshot));
      Object.assign(character, structuredClone(record.chronoxSnapshot));
      character.special.rewindUsesRemaining = rewindUsesRemaining; // re-assert past the restore
      character.usedSpecial = usedSpecial;
      character.special.usedWorldStops = usedWorldStops;
      caster.special.controlling = controlling;
      caster.special.puppetCharacterId = puppetCharacterId;
      if (deathproofActive !== undefined) caster.special.deathproofActive = deathproofActive;
      if (record.jesterBallSnapshot !== undefined) {
        game.jesterBall = structuredClone(record.jesterBallSnapshot);
      }
      // Grimtal's/Kaelis's kill/grudge counters: restored alongside the
      // caster+Chronox snapshot for the same reason it's captured in
      // turnEngine.js's buildActionAgainstChronoxRecord - a chain triggered
      // by the recorded action (e.g. a curse-mirror or a KO'd cursed
      // target) can mutate these THIRD-PARTY characters' own counters, and
      // without this they'd permanently keep a kill/grudge point for an
      // event Rewind just undid. Guarded on the character still existing
      // and being alive (a KO'd Grimtal/Kaelis has their own separate
      // death-cleanup path elsewhere; nothing to restore onto here).
      if (record.grimtalKillCounts) {
        const grimtalChar = game.characters.grimtal;
        if (grimtalChar && !grimtalChar.isKO) {
          grimtalChar.special.ownKillCount = record.grimtalKillCounts.ownKillCount;
          grimtalChar.special.unclaimedKillCount = record.grimtalKillCounts.unclaimedKillCount;
        }
      }
      if (record.kaelisGrudgeCounts) {
        const kaelisChar = game.characters.kaelis;
        if (kaelisChar && !kaelisChar.isKO) {
          kaelisChar.special.grudgeCounts = structuredClone(record.kaelisGrudgeCounts);
        }
      }
      // Lock: that exact same action is barred against Chronox specifically
      // for the caster's own next turn only (see turnEngine.js's
      // isValidTarget/tickChronoxLockoutIfAny for enforcement/timing).
      character.special.lockedActionCasterId = record.casterId;
      character.special.lockedActionId = record.actionId;
      character.special.lockedActionTurnsRemaining = 1;
      character.special.lastActionAgainstMe = null;
      log.push({
        type: 'special', characterId: character.id, actionId: 'rewind',
        rewoundCasterId: record.casterId, rewoundActionId: record.actionId,
      });
      return {};
    },
  },
};
