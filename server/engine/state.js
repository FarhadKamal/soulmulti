const MAX_HEARTS = 7;

function baseSpecialFor(id) {
  switch (id) {
    case 'chronox':
      // hasActedOnce: gates Time Freeze off his very first turn (see
      // chronox.js's timeFreeze.isLegal) - same pattern as Velorya's own
      // hasActedOnce for Moonstep. Set true inside cyclonePunch/timeFreeze's
      // own execute, same as any real action counting as "he's acted."
      return { freezeActive: false, freezeTargetId: null, freezeSkipsApplied: 0, hasActedOnce: false };
    case 'tharox':
      return { hasCharge: false };
    case 'zerathys':
      return { chargeCount: 0 };
    case 'akyros':
      return { marks: new Set(), revealedMarks: new Set(), everMarkedIds: new Set(), dodgedAttackerIds: new Set() };
    case 'velorya':
      return { lastTargetId: null, hasActedOnce: false, eclipseAttacksSinceCast: 0 };
    case 'boingo':
      // jesterBallsUsed: gates Jester Ball's own isLegal (boingo.js) - 2
      // total throws per match instead of the usual 1 (buffed after live
      // win-rate data showed him as the clear roster outlier at 0/15 wins -
      // the ball's one real safety valve, being passed back to him for a
      // free +4 heal, gets rationally denied by every other bot in an FFA
      // since it's bad for them, leaving Chaos Gamble's real ~34% miss
      // rate with nothing to fall back on). A second throw doesn't fix
      // that underlying gap directly, but gives him twice the board
      // presence/tempo-disruption and twice the chances for the return-
      // heal to actually land. Deliberately its OWN counter, not reusing
      // the generic usedSpecial boolean every other character's signature
      // move shares - usedSpecial is read by name in several places
      // (Zerathys/Draxus bot-AI banked-special checks, Rowan's Silence
      // Lock target filter) as a plain "has this character's ONE special
      // move been used" boolean, and none of those call sites are Boingo-
      // specific, so overloading it to count to 2 for him alone would
      // silently break every one of those generic checks the moment he
      // still has a second throw banked.
      return { jesterBallsUsed: 0 };
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
      // koCount: how many characters GRIMTAL HIMSELF has personally KO'd -
      // drives Grim Strike's own damage (1 + koCount), incremented directly
      // inside applyDamage's KO branch (damagePipeline.js) rather than here,
      // since any of his attacks (not just grimStrike) could land a killing
      // blow. Does NOT increase from a KO some other character lands.
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
      // lands - headacheRoll is decided live at the START of the VICTIM's
      // own next turn (not at cast time - confirmed ruling), then both are
      // cleared the instant that turn's roll resolves, win or lose. Lives
      // on Grimtal (the caster) rather than the victim, matching every
      // other caster-side effect in the codebase (Akyros's marks, Athena's
      // curseTargetCharacterId, Rowan's poisonTargets).
      return {
        koCount: 0,
        lastHitByThisCycle: new Set(),
        skullCrackUsed: 0,
        headacheVictimId: null,
        headacheRollPending: true,
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
    usedSpecial: false,
    untargetable: false,
    special: baseSpecialFor(defId),
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
    jesterBall: null,
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
