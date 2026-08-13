import { cloneGame } from './state.js';
import * as chronox from '../abilities/chronox.js';
import * as tharox from '../abilities/tharox.js';
import * as zerathys from '../abilities/zerathys.js';
import * as akyros from '../abilities/akyros.js';
import * as velorya from '../abilities/velorya.js';
import * as boingo from '../abilities/boingo.js';
import * as blade from '../abilities/blade.js';
import * as athena from '../abilities/athena.js';
import * as melyssa from '../abilities/melyssa.js';

const ABILITY_MODULES = { chronox, tharox, zerathys, akyros, velorya, boingo, blade, athena, melyssa };

export function getAbilityModule(characterId) {
  return ABILITY_MODULES[characterId];
}

export function getLegalActions(character, game) {
  const mod = ABILITY_MODULES[character.id];
  if (!mod) return [];
  return Object.entries(mod.actions)
    .filter(([, def]) => !def.hidden && def.isLegal(character, game))
    .map(([actionId, def]) => ({ actionId, ...def }));
}

// Default enemy-only targeting rule shared by most actions, plus the couple
// of action-specific restrictions (Shadow Execution requires a mark).
export function isValidTarget(game, characterId, actionId, targetId) {
  const target = game.characters[targetId];
  if (!target || target.isKO) return false;
  const character = game.characters[characterId];
  if (target.ownerId === character.ownerId) return false;
  // tutorial3 (Velorya's 1v2) is the one room where two DIFFERENT players
  // are both bots on the same side (Boingo and Athena, both opposing
  // Velorya) - the engine's ally check is otherwise purely ownerId-based
  // (one player = one side), so without this they'd wrongly see each other
  // as legal targets.
  if (game.mode === 'tutorial3' && characterId !== 'velorya' && targetId !== 'velorya') return false;
  if (target.untargetable) return false;
  if (actionId === 'shadowExecution') return character.special.marks.has(targetId);
  if (actionId === 'hiddenMark') return !character.special.everMarkedIds.has(targetId);
  return true;
}

// True if targetId is under an ACTIVE Time Freeze right now, regardless of
// the momentary skipNextTurn flag. skipNextTurn is transient - it's set
// true only from the moment Chronox's onTurnStart re-applies the freeze
// until the frozen character's own turn consumes it (consumeSkipIfFrozen
// resets it straight back to false the instant their turn is skipped).
// Time Freeze's real duration is 2 full rounds (freezeActive/
// freezeTargetId/freezeSkipsApplied on the CASTING Chronox), so there's a
// real window - from the frozen character's skipped turn until Chronox's
// own next turn re-applies it - where skipNextTurn reads false even though
// the freeze is still conceptually active for its second round. Confirmed
// live: Melyssa could puppet a still-frozen character during exactly that
// window, before this check existed.
function isCurrentlyFrozen(game, targetId) {
  return Object.values(game.characters).some(
    (c) => c.id === 'chronox' && !c.isKO && c.special.freezeActive && c.special.freezeTargetId === targetId
  );
}

// Melyssa's Mind Control is the one action in the game allowed to target
// allies - isValidTarget's enemy-only rule (ownerId check) is load-bearing
// for every other action's semantics, so this is a DEDICATED function
// rather than a per-actionId bypass baked into isValidTarget itself.
export function isValidMindControlTarget(game, targetId) {
  const target = game.characters[targetId];
  if (!target || target.id === 'melyssa') return false;
  if (target.isKO || target.untargetable || target.skipNextTurn) return false;
  if (isCurrentlyFrozen(game, targetId)) return false;
  return true; // deliberately no ownerId check - ally or enemy both legal
}

// A puppeted character's REAL action, once Melyssa has taken control, is
// allowed to hit ANY other character on the board - including the puppet's
// own teammate - not just who the puppet would normally consider an enemy.
// Requested directly: "she can chose blade attack on tharox" (both on the
// same enemy team) - being forced to turn on your own ally is a genuine
// extra threat Mind Control should be able to create, beyond what
// isValidTarget's ownership check allows for a character acting normally.
// Same shape as isValidTarget (KO'd/untargetable exclusions, Shadow
// Execution's mark requirement, hiddenMark's once-ever-marked rule) minus
// the ownerId equality check - just also excludes the puppet targeting
// itself, which isValidTarget gets for free from the ownerId check but
// this function has to state explicitly since it no longer has that check
// as a side effect.
export function isValidPuppetTarget(game, puppetId, actionId, targetId) {
  if (targetId === puppetId) return false;
  const target = game.characters[targetId];
  if (!target || target.isKO) return false;
  const puppet = game.characters[puppetId];
  if (game.mode === 'tutorial3' && puppetId !== 'velorya' && targetId !== 'velorya') return false;
  if (target.untargetable) return false;
  if (actionId === 'shadowExecution') return puppet.special.marks.has(targetId);
  if (actionId === 'hiddenMark') return !puppet.special.everMarkedIds.has(targetId);
  return true;
}

export function hasAnyValidPuppetTarget(game, puppetId, actionId) {
  return Object.keys(game.characters).some((tid) => isValidPuppetTarget(game, puppetId, actionId, tid));
}

export function hasAnyValidTarget(game, characterId, actionId) {
  // mindControl routes through isValidMindControlTarget (ally-allowed),
  // never isValidTarget (enemy-only) - without this, getUsableActions would
  // wrongly hide her Mind Control button whenever no ENEMY target exists,
  // even if a perfectly valid ally puppet is available.
  if (actionId === 'mindControl') {
    return Object.keys(game.characters).some((tid) => isValidMindControlTarget(game, tid));
  }
  return Object.keys(game.characters).some((tid) => isValidTarget(game, characterId, actionId, tid));
}

// Legal actions that are also actually usable right now - i.e. targeted
// actions are excluded if there is currently no valid target for them
// (e.g. every enemy is KO'd or untargetable).
export function getUsableActions(character, game) {
  return getLegalActions(character, game).filter((action) => {
    if (!action.needsTarget) return true;
    return hasAnyValidTarget(game, character.id, action.actionId);
  });
}

// Puppet-aware counterpart to getUsableActions - same legal-action list
// (getLegalActions doesn't know or care about targets at all), but a
// targeted action's "is this even usable right now" check goes through
// hasAnyValidPuppetTarget instead of hasAnyValidTarget, so a puppeted
// character whose only legal target is their OWN teammate still shows the
// button (getUsableActions would wrongly hide it, same class of gap
// isValidMindControlTarget's own hasAnyValidTarget branch already fixed
// for Melyssa's own selection step).
export function getUsablePuppetActions(puppetCharacter, game) {
  return getLegalActions(puppetCharacter, game).filter((action) => {
    if (!action.needsTarget) return true;
    return hasAnyValidPuppetTarget(game, puppetCharacter.id, action.actionId);
  });
}

// Runs turn-start passives for a character (shield gain, freeze flip, shield decay).
export function beginCharacterTurn(character, game, log) {
  const mod = ABILITY_MODULES[character.id];
  if (mod?.onTurnStart) mod.onTurnStart(character, game, log);
}

export function executeAction(game, characterId, actionId, targetId, extra) {
  const character = game.characters[characterId];
  const mod = ABILITY_MODULES[characterId];
  const actionDef = mod.actions[actionId];
  const log = [];
  const result = actionDef.execute(character, targetId, game, log, extra);
  finalizeAction(game, log, result, characterId, actionId, targetId);
  return result;
}

// Extracted from executeAction so a non-ability-map damage source (Melyssa's
// Self Choke, server/index.js's executeSelfChoke) can share the same
// end-of-action bookkeeping (elimination/game-over detection, hearts
// snapshot, deferred rebirth/mirror log entries) without needing a fake
// entry in some character's actions map. Pure extraction - executeAction's
// own behavior is unchanged.
export function finalizeAction(game, log, result, characterId, actionId, targetId) {
  // Blade's Rebirth and Athena's curse-mirror log entries are deferred
  // until here so they land AFTER the triggering attack's own log entry,
  // not before it. Rebirth can also fire on the MIRROR hit itself (curse
  // damage killing Blade), so check both the direct result and, once the
  // mirror's own entry is queued, the mirror result too.
  if (result?.rebirthLogEntry) log.push(result.rebirthLogEntry);
  if (result?.mirrorLogEntry) log.push(result.mirrorLogEntry);
  if (result?.mirrorResult?.rebirthLogEntry) log.push(result.mirrorResult.rebirthLogEntry);
  applyEndOfActionChecks(game);
  game.log.push(...log, { type: 'end-action', round: game.round, characterId, actionId, targetId, hearts: heartsSnapshot(game) });
}

// Executes a puppeted action on behalf of Melyssa's Mind Control - calls
// the normal executeAction(game, puppetId, ...) (puppet's own ability
// module runs unmodified, so Dodge/curse-mirror/Rebirth all attribute to
// the puppet automatically), then stamps controllingMelyssaId onto every
// log entry it just produced. Without this stamp, the client has no way to
// know a given puppet-attributed log entry was Melyssa-driven (needed for
// her own mind_control_action.jpg flash to fire alongside the puppet's own
// normal flash - see client/js/portraitFlash.js).
export function executeActionAsPuppet(game, melyssaCharacterId, puppetCharacterId, actionId, targetId, extra) {
  const before = game.log.length;
  const result = executeAction(game, puppetCharacterId, actionId, targetId, extra);
  for (let i = before; i < game.log.length; i++) {
    game.log[i].controllingMelyssaId = melyssaCharacterId;
  }
  return result;
}

export function resolveJesterBall(game, holderCharacterId, choice, extra) {
  const log = [];
  const res = boingo.jesterBallResolution[choice];
  const result = res.execute(game, log, extra);
  if (result?.rebirthLogEntry) log.push(result.rebirthLogEntry);
  applyEndOfActionChecks(game);
  game.log.push(...log, { type: 'end-action', round: game.round, characterId: holderCharacterId, actionId: `jesterBall:${choice}`, hearts: heartsSnapshot(game) });
  return result;
}

// Snapshot of every character's current hearts (or 'KO'), taken right after
// an action fully resolves - attached to the end-action marker so the log
// can show a running health readout after each turn without needing the
// reader to hand-tally damage across the whole match.
function heartsSnapshot(game) {
  const snap = {};
  for (const c of Object.values(game.characters)) {
    snap[c.id] = c.isKO ? 'KO' : c.hearts;
  }
  return snap;
}

function applyEndOfActionChecks(game) {
  for (const player of game.players) {
    player.isEliminated = player.characterIds.every((id) => game.characters[id].isKO);
  }
  const remaining = game.players.filter((p) => !p.isEliminated);
  if (remaining.length === 1) {
    game.phase = 'game-over';
    game.winnerPlayerId = remaining[0].id;
  } else if (remaining.length === 0) {
    // A single action (e.g. Athena's curse mirror killing both the
    // attacker and Athena at once) can eliminate every remaining player
    // simultaneously - that's a draw, not a soft-lock.
    game.phase = 'game-over';
    game.winnerPlayerId = null;
  }
}

export function currentPlayer(game) {
  return game.players.find((p) => p.id === game.turnOrder[game.activePlayerIndex]);
}

export function charactersActingThisTurn(game) {
  const player = currentPlayer(game);
  return player.characterIds
    .map((id) => game.characters[id])
    .filter((c) => !c.isKO);
}

export function hasCharacterActedThisTurn(game, characterId) {
  return game.actedThisTurn.has(characterId);
}

export function markCharacterActed(game, characterId) {
  game.actedThisTurn.add(characterId);
}

// Advances to the next player whose turn it is (skipping eliminated players
// and players whose entire roster is currently frozen/has nothing to do —
// frozen characters just get their skip consumed here, they don't block turn advancement).
export function endTurn(game) {
  game.actedThisTurn = new Set();
  game.turnStartFiredFor = new Set();
  const n = game.turnOrder.length;
  let next = game.activePlayerIndex;
  for (let i = 0; i < n; i++) {
    next = (next + 1) % n;
    const player = game.players.find((p) => p.id === game.turnOrder[next]);
    if (!player.isEliminated) break;
  }
  if (next <= game.activePlayerIndex) {
    game.round += 1;
  }
  game.activePlayerIndex = next;
}

// Consumes a character's frozen state; returns true if they should skip.
export function consumeSkipIfFrozen(character) {
  if (character.skipNextTurn) {
    character.skipNextTurn = false;
    return true;
  }
  return false;
}

// ---- Undo (single-level snapshot) ----
export function snapshot(game) {
  return cloneGame(game);
}

export function restoreSnapshot(snap) {
  return cloneGame(snap);
}
