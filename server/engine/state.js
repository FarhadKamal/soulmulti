const MAX_HEARTS = 7;

function baseSpecialFor(id) {
  switch (id) {
    case 'chronox':
      return { freezeActive: false, freezeTargetId: null, freezeSkipsApplied: 0 };
    case 'tharox':
      return { hasCharge: false };
    case 'zerathys':
      return { chargeCount: 0 };
    case 'akyros':
      return { marks: new Set(), revealedMarks: new Set(), everMarkedIds: new Set(), dodgedAttackerIds: new Set() };
    case 'velorya':
      return { lastTargetId: null, hasActedOnce: false, eclipseAttacksSinceCast: 0 };
    case 'boingo':
      return {};
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
      return {
        discoveredSpells: new Set(),
        arcaneStudyPending: false,
        arcaneStudyOnCooldown: false,
        mirrorReflectActive: false,
        poisonTargets: new Set(),
        silenceTargets: new Map(),
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
