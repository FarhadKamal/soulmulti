const MAX_HEARTS = 7;

function baseSpecialFor(id) {
  switch (id) {
    case 'chronox':
      // hasActedOnce: gates Time Freeze off his very first turn (see
      // chronox.js's timeFreeze.isLegal) - same pattern as Velorya's own
      // hasActedOnce for Moonstep. Set true inside cyclonePunch/timeFreeze's
      // own execute, same as any real action counting as "he's acted."
      // rewindUsesRemaining: Rewind can be cast twice per match, tracked separately from
      // usedSpecial since usedSpecial is already spoken for by Time Freeze
      // (matching how every other multi-special-move character - Rowan's
      // usedSpells Set, Boingo's jesterBallsUsed counter - avoids
      // overloading the single shared boolean).
      // lastActionAgainstMe: a full snapshot of game state taken
      // IMMEDIATELY BEFORE the most recent action that targeted him
      // resolved (see turnEngine.js's executeAction, which records this
      // generically for every action in the game, not just ones aimed at
      // Chronox - keeping it fully game-agnostic rather than hand-writing
      // per-ability undo logic). null until something has actually
      // targeted him. Shape: { casterId, actionId, gameSnapshot } where
      // gameSnapshot is a structuredClone of the ENTIRE game.characters +
      // game.jesterBall as they existed right before that action ran -
      // Rewind restores from this wholesale rather than trying to compute
      // a targeted diff, so it correctly handles every kind of effect in
      // the game uniformly (plain damage, curse/freeze/mark/silence/
      // headache statuses, Soul Swap's heart-swap, Illyra's multi-target
      // Mirage Burst, Jester Ball's global holder state) with zero
      // per-ability special-casing needed.
      // lockedActionCasterId/lockedActionId/lockedActionTurnsRemaining:
      // after a Rewind, the refunded caster is barred from using that
      // EXACT SAME action against Chronox specifically for their own next
      // turn only. turnsRemaining starts at 1 the instant Rewind resolves
      // and is decremented at the start of the locked caster's OWN next
      // turn (turnEngine.js's beginCharacterTurn, same victim-turn-tick
      // shape Rowan's silenceTargets Map already uses) - reaching 0 clears
      // the whole lock, restoring the caster's normal options from their
      // turn after that onward. Enforced generically in turnEngine.js's
      // isValidTarget.
      // worldStopsActive/worldStopsFrozenIds/worldStopsSkipsApplied: his
      // second special (confirmed ruling) - a one-time, all-opponents
      // version of Time Freeze, legal only at hearts <= 3 (same
      // desperation-move gate as Illyra's Mirage Overload/Tharox's
      // Earthshatter, not the hasActedOnce gate Time Freeze uses). Own
      // dedicated usedWorldStops flag, separate from usedSpecial (already
      // spoken for by Time Freeze) - same multi-special pattern as
      // rewindUsesRemaining above. Single SHARED countdown for the whole
      // frozen group (confirmed ruling: simpler than per-target countdowns)
      // - worldStopsFrozenIds is the Set of character ids who were frozen
      // at cast time, worldStopsSkipsApplied mirrors freezeSkipsApplied's
      // own countdown shape (see chronox.js's WORLD_STOPS_TOTAL_ROUNDS,
      // 4 rounds total - confirmed ruling) but ticks once for the whole
      // group together, not per target.
      return {
        freezeActive: false, freezeTargetId: null, freezeSkipsApplied: 0, hasActedOnce: false,
        rewindUsesRemaining: 2,
        worldStopsActive: false, worldStopsFrozenIds: new Set(), worldStopsSkipsApplied: 0, usedWorldStops: false,
        lastActionAgainstMe: null,
        lockedActionCasterId: null,
        lockedActionId: null,
        lockedActionTurnsRemaining: 0,
      };
    case 'tharox':
      // usedEarthshatter: separate one-time flag from usedSpecial (which
      // Glory Smash owns) - the two specials are fully independent, either
      // can fire once per match regardless of order. Earthshatter itself
      // doesn't touch hasCharge at all - its only gate is his own hearts
      // (see tharox.js's isLegal).
      // glorySmashesUsed: Glory Smash is now good for 2 casts per match
      // (confirmed ruling), same "counter instead of a single boolean"
      // pattern as Boingo's jesterBallsUsed - usedSpecial only flips true
      // once BOTH are spent (see tharox.js), so this counter is what lets
      // the UI show "1/2 used, one still in reserve" instead of just a
      // flat used/unused flag.
      return { hasCharge: false, usedEarthshatter: false, glorySmashesUsed: 0 };
    case 'zerathys':
      return { chargeCount: 0 };
    case 'akyros':
      return { marks: new Set(), revealedMarks: new Set(), everMarkedIds: new Set(), dodgedAttackerIds: new Set() };
    case 'velorya':
      return { lastTargetId: null, hasActedOnce: false, eclipseAttacksSinceCast: 0 };
    case 'boingo':
      // jesterBallsUsed: gates Jester Ball's own isLegal (boingo.js) - back
      // to 1 throw per match (an earlier 2-throw buff was reverted
      // alongside this rework). Deliberately its OWN counter rather than
      // reusing the generic usedSpecial boolean, matching every other
      // multi-flag character's pattern (Chronox's rewindUsesRemaining,
      // Tharox's glorySmashesUsed) even though it now only ever reaches 1 -
      // keeps the shape consistent and avoids re-plumbing every call site
      // that reads jesterBallsUsed directly.
      // usedFowlPlay: his desperation special (hearts <= 3, confirmed
      // ruling), own dedicated one-time flag separate from usedSpecial
      // (already spoken for by Jester Ball) - same multi-special pattern
      // as Chronox's usedWorldStops/Grimtal's usedGrimBarrage. Who's
      // currently chickenified lives per-character on each victim's own
      // `isChicken` flag, and the shared countdown lives on `game`,
      // not here - see createCharacter's own comment and createGame's
      // fowlPlayHitsOnBoingo counter.
      return { jesterBallsUsed: 0, usedFowlPlay: false };
    case 'blade':
      return { streakTargetId: null, streakCount: 0, rebirthUsed: false };
    case 'athena':
      return { curseTargetCharacterId: null };
    case 'melyssa':
      // controlling: true for the entire duration of a Mind Control
      // sequence (from puppet selection through the puppeted action, and
      // any nested follow-up) - drives portraitFlash.js's held
      // "mind_control_selection.jpg" portrait client-side. puppetCharacterId
      // is who's currently being controlled, set alongside controlling
      // (melyssa.js's mindControl.execute) - drives the puppet's own
      // hypnotic-ripple tile effect client-side for that same window. Both
      // cleared by finishMelyssaTurn (server/index.js) at the exact 3
      // points a Mind Control turn is truly over.
      return { controlling: false, puppetCharacterId: null };
    case 'kaelis':
      // grudgeCounts: per-attacker hit counter (Map<characterId, number>),
      // incremented in damagePipeline.js's applyDamage every time that
      // attacker lands a real hit on her. A landed Grudge Strike against
      // ANY target deals the base 1 damage PLUS their current count (e.g.
      // 1 stored hit -> 2 damage total), then resets that specific
      // attacker's count back to 0 regardless (their next hit starts the
      // count over from 1) - see kaelis.js. Also reset to 0 if that
      // attacker revives (see the Rebirth block in applyDamage).
      // ashkaHealsRemaining: counts her own remaining FOLLOW-UP heal ticks
      // from Call Ashka (not counting the cast turn's own immediate heal) -
      // ticked down in kaelis.js's onTurnStart.
      return { grudgeCounts: new Map(), ashkaHealsRemaining: 0 };
    case 'draxus':
      // deathproofActive: true from the moment Deathless Fury is cast
      // until his own next onTurnStart clears it (see draxus.js) -
      // checked on every qualifying hit in damagePipeline.js's applyDamage
      // to floor lethal damage at 1 instead of KO'ing him.
      // bonusActionsRemaining: set to 3 by his own onTurnStart when the
      // window above just ended - decremented in index.js's handleAction/
      // stepBotTurn instead of calling markCharacterActed, until it hits 0.
      return { deathproofActive: false, bonusActionsRemaining: 0 };
    case 'rowan':
      // discoveredSpells: which of the 5 spells Arcane Study has revealed so
      // far this match (never re-drawn once discovered) - see rowan.js.
      // arcaneStudyPending/arcaneStudyOnCooldown: set together on cast,
      // both cleared by his own onTurnStart one turn later (the reveal
      // happens then too) - same one-turn-delay shape as Draxus's
      // deathproofActive window.
      // poisonTargets: Set<targetCharacterId> currently affected by Poison
      // Cloud - ticks 1 dmg on THAT character's own turn start (see
      // turnEngine.js's tickPoisonIfAny), lives on Rowan (the caster) so
      // his own death can clear it directly, matching every other
      // caster-side effect in the codebase (Akyros's marks, Athena's
      // curseTargetCharacterId, Chronox's freezeTargetId).
      // silenceTargets: Map<targetCharacterId, turnsRemaining> for Silence
      // Lock - decremented on that target's own turn start, deleted at 0.
      // mirrorReflectActive: true from cast until his own next
      // onTurnStart clears it - checked in damagePipeline.js's applyDamage.
      // usedSpells: Set<spellId> - each of the 5 discovered spells is
      // one-time-use, same as any other special ability (usedSpecial's
      // shape), just tracked per-spell instead of a single shared boolean
      // since he can have several discovered spells at once but each is
      // independently spent the moment it's first cast.
      return {
        discoveredSpells: new Set(),
        arcaneStudyPending: false,
        arcaneStudyOnCooldown: false,
        mirrorReflectActive: false,
        poisonTargets: new Set(),
        silenceTargets: new Map(),
        usedSpells: new Set(),
      };
    case 'marin':
      // discoveredSpells/arcaneStudyPending/arcaneStudyOnCooldown: identical
      // shape/reasoning to Rowan's own fields above (same Arcane Study
      // mechanic, shared chassis). Unlike Rowan's kit (situational tools he
      // chooses WHEN to deploy), every one of Marin's 5 spells auto-
      // activates the instant it's discovered - no separate cast action
      // exists for any of them (see marin.js: only wandStrike/arcaneStudy
      // appear in her actions map).
      // everbloomActive: true forever once discovered - checked each of her
      // own onTurnStart calls (marin.js) to heal +1.
      // veilChargesRemaining: starts at 3 the instant Threefold Veil is
      // discovered, decremented by 1 each time it actually blocks a hit
      // (damagePipeline.js's applyDamage, same dodge-shape as Akyros's own
      // dodge check but a flat shared pool instead of per-attacker) - once
      // it hits 0 the passive is simply spent, no recharge.
      // cleanSlateArmed: true the instant discovered, flips to false the
      // moment it actually fires (reactive one-time trigger - see
      // tryTriggerCleanSlate/isImmuneToNegativeStatus in damagePipeline.js,
      // called from each of the 5 status-application ability files).
      // Distinguishes "discovered, still waiting to trigger" from "already
      // spent."
      // cleanSlateImmuneTurnsRemaining: set to 3 the instant it fires,
      // decremented on each of her own turn-starts (marin.js's
      // onTurnStart), same victim-turn-tick shape as Rowan's silence
      // countdown but self-targeted so no cross-character scan is needed.
      // piercingWandActive/wandMasteryActive: true forever once discovered,
      // both checked directly inside wandStrike's own execute (marin.js) to
      // fold their effects (ignoresShield / +1 damage) into every future
      // Wand Strike - confirmed stacking (both apply together with no
      // conflict), and the button stays labeled "Wand Strike" regardless of
      // which/how many of these are unlocked.
      // everbloomFirstTickDone: flips true after Everbloom's very first
      // heal tick - lets the client (main.js) play her spoken voice line
      // only once (the moment it starts) while the short sound effect
      // itself still plays on every recurring tick for the rest of the
      // match, same reasoning as not wanting a full sentence repeating
      // every single turn.
      // everbloomTurnCount: increments every one of her own turns while
      // Everbloom is active (whether or not that turn heals) - odd counts
      // heal, even counts skip, so it heals every OTHER turn forever
      // rather than every single turn (balance tune - see marin.js).
      return {
        discoveredSpells: new Set(),
        arcaneStudyPending: false,
        arcaneStudyOnCooldown: false,
        everbloomActive: false,
        everbloomFirstTickDone: false,
        everbloomTurnCount: 0,
        veilChargesRemaining: 0,
        cleanSlateArmed: false,
        cleanSlateImmuneTurnsRemaining: 0,
        piercingWandActive: false,
        wandMasteryActive: false,
      };
    case 'grimtal':
      // Grim Strike's damage is 1 + ownKillCount + claimedKillCount:
      // - ownKillCount: KOs GRIMTAL HIMSELF personally lands (any of his
      //   attacks, not just grimStrike) - increments automatically, no
      //   button needed, inside applyDamage's KO branch.
      // - claimedKillCount: KOs someone ELSE landed that Grimtal has since
      //   spent a whole turn actively claiming via the Claim the Kill
      //   action (see actions.claimKill below) - does NOT increment
      //   automatically just because a death happened.
      // unclaimedKillCount: how many of OTHER characters' kills are
      // currently banked and waiting to be claimed - increments on every
      // non-Grimtal KO (any source: another player's attack, a poison
      // tick, a curse mirror, anything), decrements by 1 each time
      // Claim the Kill is actually cast. Deaths bank up if he doesn't
      // claim them right away - confirmed ruling: 2 kills he didn't land
      // before his next turn means 2 separate turns to claim both, not one
      // turn to claim everything at once.
      // lastHitByThisCycle: Set<attackerCharacterId> - everyone who has
      // landed an attack on him since his own last turn ended (cleared at
      // the start of his own turn, turnEngine.js's beginCharacterTurn calls
      // resetGrimtalCycle). Grim Ward's live-dodge check in applyDamage
      // reads this to tell "am I the 2nd+ distinct attacker this cycle" -
      // the attacker doesn't need to have dealt real damage, only to have
      // made the attempt (confirmed ruling: a 0-damage first hit still sets
      // up the dodge on the next attacker).
      // skullCrackUsed: count of Skull Crack casts so far (3 allowed/match) -
      // a plain counter rather than usedSpecial's single boolean, same
      // reasoning as Boingo's jesterBallsUsed (usedSpecial is read
      // elsewhere as a flat "has the ONE special been used" flag, and only
      // flips true here once all 3 casts are spent).
      // headacheVictimId/headacheRoll: set together the instant Skull Crack
      // (or Grim Barrage) lands - headacheRoll is decided live at the START
      // of the VICTIM's own next turn (not at cast time - confirmed
      // ruling), then both are cleared the instant that turn's roll
      // resolves, win or lose. Lives on Grimtal (the caster) rather than
      // the victim, matching every other caster-side effect in the
      // codebase (Akyros's marks, Athena's curseTargetCharacterId, Rowan's
      // poisonTargets).
      // usedGrimBarrage: his desperation special (hearts <= 3, confirmed
      // ruling) - own dedicated one-time flag, separate from usedSpecial
      // (already spoken for by Skull Crack), same multi-special pattern as
      // Chronox's usedWorldStops. 3 independent random-target hits, each
      // Environmental Attack (bypasses dodge, shield still absorbs) and
      // each rolling its own headache-roll attempt on whoever it lands on
      // - see grimtal.js's grimBarrage action.
      return {
        ownKillCount: 0,
        claimedKillCount: 0,
        unclaimedKillCount: 0,
        lastHitByThisCycle: new Set(),
        skullCrackUsed: 0,
        headacheVictimId: null,
        headacheRollPending: true,
        usedGrimBarrage: false,
      };
    case 'illyra':
      // mirageMarks: Map<targetCharacterId, stackCount> - how many
      // uncapped Mirage Mark stacks currently sit on each enemy. Lives on
      // Illyra (the caster), matching every other caster-side effect in
      // the codebase (Akyros's marks, Athena's curseTargetCharacterId,
      // Rowan's poisonTargets) - so her own death can clear it directly if
      // ever needed, and Blade's Rebirth "comes back fresh" cleanup can
      // strip a target's own stacks on revival, same pattern as Rowan's
      // poison/Kaelis's grudge count. Mirage Burst (her special) zeroes out
      // ONE target's count on detonation (confirmed ruling: clears after
      // bursting) - stacks on every OTHER target are untouched. No cap on
      // how high a single target's count can climb (confirmed ruling).
      // Her passive 50% dodge (both the applyDamage block and
      // tryIllyraDodgeStatus) needs no tracked state at all - it's a pure,
      // memoryless coin flip every single time, unlike Akyros's per-
      // attacker Set or Marin's finite charge pool.
      // mirageOverloadUsed: her one-time Mirage Overload special (see
      // illyra.js) - a dedicated flag rather than the shared usedSpecial
      // boolean, matching every other multi-special character's own
      // pattern (Chronox's rewindUsesRemaining, Boingo's jesterBallsUsed) -
      // though in her case there's no OTHER special competing for
      // usedSpecial, this still keeps the convention consistent and leaves
      // room for a future second special without a collision.
      return {
        mirageMarks: new Map(),
        mirageOverloadUsed: false,
      };
    case 'oraclus':
      // predictedAttackerId/predictedTargetId: his one pending Rune Vision
      // guess, null when nothing is pending. Checked against the VERY NEXT
      // real attack anyone takes (see turnEngine.js's
      // resolveOraclusPredictionIfPending) - NOT cleared by a
      // freeze/headache/no-target skip, since those aren't the predicted
      // attacker's "real action" (confirmed ruling: the guess waits through
      // skips for their next genuine attack).
      // predictionWins: capped at 2 - runeVision.isLegal goes false once
      // this hits 2, permanently retiring the ability for the rest of the
      // match (confirmed ruling).
      // runeStrikeBonusDamage: +1 permanent, non-decaying, per correct
      // prediction (so max +2 once both wins are banked) - added on top of
      // Rune Strike's own base damage.
      return {
        predictedAttackerId: null,
        predictedTargetId: null,
        predictionWins: 0,
        runeStrikeBonusDamage: 0,
      };
    default:
      return {};
  }
}

function baseShieldFor(id) {
  // Chrono Guard is active from the start of the match, not just from
  // Chronox's own first turn onward.
  return id === 'chronox' ? 1 : 0;
}

export function createCharacter(defId, ownerId) {
  return {
    id: defId,
    ownerId,
    hearts: MAX_HEARTS,
    maxHearts: MAX_HEARTS,
    shield: baseShieldFor(defId),
    shieldDecaying: false,
    isKO: false,
    skipNextTurn: false,
    // Grimtal's Skull Crack headache - deliberately separate from
    // skipNextTurn (Chronox's Time Freeze), see turnEngine.js's
    // resolveHeadacheIfDue/consumeSkipIfHeadache for why sharing one flag
    // produced a wrong "is frozen" message for a headache-caused skip.
    skipHeadacheTurn: false,
    usedSpecial: false,
    untargetable: false,
    special: baseSpecialFor(defId),
    // Boingo's Fowl Play - true means currently chickenified. Set true on
    // every OTHER living character the instant Fowl Play is cast (Boingo
    // himself is never touched), cleared back to false on EVERY living
    // character simultaneously once game.fowlPlayActive itself ends (see
    // createGame's own comment - the real countdown lives there, not per-
    // character, since everyone reverts together at the same moment).
    // Lives directly on the character (not nested in `special`) for the
    // same reason skipNextTurn/skipHeadacheTurn do - a plain, universally-
    // applicable flag rather than a per-hero-shaped state blob.
    isChicken: false,
  };
}

export function createPlayer(id, name, characterIds, isPC = false) {
  return {
    id,
    name,
    characterIds: [...characterIds],
    isEliminated: false,
    isPC,
  };
}

export function createGame(mode, playerPicks) {
  // playerPicks: [{ id, name, characterIds: [...], isPC }, ...]
  const characters = {};
  const players = playerPicks.map((p) => {
    p.characterIds.forEach((cid) => {
      characters[cid] = createCharacter(cid, p.id);
    });
    return createPlayer(p.id, p.name, p.characterIds, p.isPC);
  });

  return {
    mode,
    players,
    characters,
    turnOrder: players.map((p) => p.id),
    activePlayerIndex: 0,
    round: 1,
    phase: 'player-turn',
    actedThisTurn: new Set(),
    turnStartFiredFor: new Set(),
    chronoxLockoutTickedFor: new Set(),
    turnInstanceFor: new Map(),
    jesterBall: null,
    // Boingo's Fowl Play - GLOBAL cumulative hit counter for attacks
    // chickens land specifically on Boingo (confirmed ruling: shared
    // across every chicken, not tracked per-attacker). Every 2nd
    // cumulative hit lands 1 damage; the alternating hit deals 0. Lives on
    // `game` (not per-attacker state) for the same "one shared counter,
    // not 16 separate ones" reasoning game.jesterBall's own shared state
    // uses. Never reset mid-match - persists for as long as Fowl Play's
    // chicken window is active, naturally becoming irrelevant again once
    // every chicken has reverted (nothing left that can even target
    // Boingo under the chicken-only-targets-chicken-or-Boingo rule).
    fowlPlayHitsOnBoingo: 0,
    // Boingo's Fowl Play - true for the whole chicken window, cleared the
    // instant it ends. Duration is measured in BOINGO'S OWN turns, not raw
    // global move-count (confirmed ruling, 2026-09-03 - fixed a real gap
    // where a flat move-count closed the window right before Boingo's own
    // next turn in a 4-player match, so he never actually got a chance to
    // attack a chicken himself): fowlPlayBoingoTurnsElapsed increments
    // once each time Boingo's own turn BEGINS while this is active (see
    // turnEngine.js's beginCharacterTurn), and the window ends - EVERY
    // currently-chickenified character reverts simultaneously - once it
    // reaches FOWL_PLAY_BOINGO_TURNS (his cast turn itself doesn't count
    // as one of these, only turns that begin AFTER the cast).
    fowlPlayActive: false,
    fowlPlayBoingoTurnsElapsed: 0,
    winnerPlayerId: null,
    log: [],
  };
}

export function activePlayer(game) {
  return game.players.find((p) => p.id === game.turnOrder[game.activePlayerIndex]);
}

export function ownerOf(game, characterId) {
  const char = game.characters[characterId];
  return game.players.find((p) => p.id === char.ownerId);
}

export function livingCharacters(game) {
  return Object.values(game.characters).filter((c) => !c.isKO);
}

export function livingEnemiesOf(game, characterId) {
  const owner = game.characters[characterId].ownerId;
  return livingCharacters(game).filter((c) => c.ownerId !== owner);
}

// Deep clone via structured cloning that preserves Set instances (used for undo snapshots).
export function cloneGame(game) {
  return structuredClone(game);
}
