import { cloneGame } from './state.js';
import { applyDamage, applyHeal, applyShield, isSilenced } from './damagePipeline.js';
import * as chronox from '../abilities/chronox.js';
import * as tharox from '../abilities/tharox.js';
import * as zerathys from '../abilities/zerathys.js';
import * as akyros from '../abilities/akyros.js';
import * as velorya from '../abilities/velorya.js';
import * as boingo from '../abilities/boingo.js';
import * as blade from '../abilities/blade.js';
import * as athena from '../abilities/athena.js';
import * as melyssa from '../abilities/melyssa.js';
import * as kaelis from '../abilities/kaelis.js';
import * as draxus from '../abilities/draxus.js';
import * as rowan from '../abilities/rowan.js';
import * as marin from '../abilities/marin.js';
import * as grimtal from '../abilities/grimtal.js';
import * as illyra from '../abilities/illyra.js';

const ABILITY_MODULES = { chronox, tharox, zerathys, akyros, velorya, boingo, blade, athena, melyssa, kaelis, draxus, rowan, marin, grimtal, illyra };

export function getAbilityModule(characterId) {
  return ABILITY_MODULES[characterId];
}

export function getLegalActions(character, game) {
  const mod = ABILITY_MODULES[character.id];
  if (!mod) return [];
  const silenced = isSilenced(character, game);
  return Object.entries(mod.actions)
    .filter(([, def]) => !def.hidden && def.isLegal(character, game) && !(silenced && def.special))
    .map(([actionId, def]) => ({ actionId, ...def }));
}

// Default enemy-only targeting rule shared by most actions, plus the couple
// of action-specific restrictions (Shadow Execution requires a mark).
export function isValidTarget(game, characterId, actionId, targetId) {
  const target = game.characters[targetId];
  if (!target || target.isKO) return false;
  const character = game.characters[characterId];
  if (target.ownerId === character.ownerId) return false;
  if (target.untargetable) return false;
  if (actionId === 'shadowExecution') return character.special.marks.has(targetId);
  if (actionId === 'hiddenMark') return !character.special.everMarkedIds.has(targetId);
  // Illyra's Mirage Burst: only a target with 1+ Mirage Mark stacks is a
  // valid detonation target - matches the shadowExecution shape above
  // (requires a prior mark to have been placed), same reasoning as her
  // own mirageBurst.isLegal only checking "does ANY target have stacks" at
  // the action-visibility level, while THIS is what actually filters which
  // specific enemies are offered as targets.
  if (actionId === 'mirageBurst') return (character.special.mirageMarks.get(targetId) || 0) > 0;
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

// True in the specific stalemate condition: exactly 2 characters left
// alive on the whole board, one of them Melyssa, the other her enemy.
// Curse Strike/Divine Restore (and every other character's own setup
// moves) deal 0 damage, so a puppeted enemy stuck re-casting one of those
// forever - while Melyssa does the same via Mind Control - can stall a
// match indefinitely with neither side ever losing a heart. Reported
// directly via a live scenario (Melyssa puppeting Athena into Curse
// Strike on herself, back and forth forever). Shared by both the human
// path (mindControlOptionsFor, index.js) and the bot AI
// (chooseBotMelyssaPuppetAction, botPlayer.js), so neither can stall.
export function isMelyssaLoneDuel(game, melyssaId) {
  const living = Object.values(game.characters).filter((c) => !c.isKO);
  return living.length === 2 && living.some((c) => c.id === melyssaId);
}

// Zerathys is the one deliberate exception to the lone-duel restriction:
// Soul Swap is the only ability in the game that TRANSFERS hearts rather
// than dealing damage or buffing the caster, so puppeting him is a
// genuine, real way for Melyssa to turn a losing 1v1 around (swap her low
// hearts for his high total, then his own forced Wrath follow-up can even
// be aimed back at herself) - locking that out would remove a legitimate,
// fun strategic play, not just close a stalling loophole. Every other
// puppeted kit's self-targeted options either only ever deal damage (never
// help Melyssa) or buff/heal the PUPPET, not her (Tharox's Glory Smash,
// Athena's Divine Restore, Velorya's Lunar Eclipse, Boingo's Jester Ball
// return-heal) - confirmed character-by-character before deciding this.
export const LONE_DUEL_EXCEPTIONS = new Set(['zerathys']);

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

// Rowan's Poison Cloud ticks on the POISONED character's own turn start,
// not the caster's - unlike every other recurring effect in the game
// (Chronox's freeze, Kaelis's Ashka heal, Draxus's own window), which all
// fire on the CASTER's turn. Written generically (scans every character's
// .special.poisonTargets rather than assuming Rowan specifically) so a
// future poison-capable character needs no changes here. Routes through
// applyDamage so shield/Rebirth/Mirror-Reflect interactions all stay
// consistent with every other damage source.
function tickPoisonIfAny(character, game, log) {
  if (character.isKO) return;
  const caster = Object.values(game.characters).find(
    (c) => c.special?.poisonTargets?.has(character.id)
  );
  if (!caster) return;
  // ignoresUntargetable: true - the poison was already applied while the
  // target WAS targetable; going untargetable afterward (e.g. Velorya's
  // Lunar Eclipse) shouldn't let already-active ticks skip, same reasoning
  // as Athena's curse-mirror bypassing untargetable for the same class of
  // "this effect already landed, a later dodge doesn't retroactively
  // cancel it" situation. Confirmed bug report: poison silently stopped
  // ticking (not cured, just permanently no-op) the moment the victim went
  // untargetable, with no way to ever resume even after Eclipse ended.
  const result = applyDamage(game, log, {
    sourceCharacterId: caster.id,
    targetCharacterId: character.id,
    amount: 1,
    ignoresUntargetable: true,
    isPoisonTick: true,
  });
  log.push({ type: 'poison-tick', casterId: caster.id, targetCharacterId: character.id, ...result });
  // Same deferred-log-entry handling as finalizeAction: applyDamage returns
  // curse-mirror/rebirth entries on the result rather than pushing them
  // itself, so a poison tick that kills a cursed Athena (mirroring damage
  // onto her cursed target) needs this path to push them too, or that
  // mirror hit happens with no corresponding log line at all.
  if (result.rebirthLogEntry) log.push(result.rebirthLogEntry);
  if (result.mirrorLogEntry) log.push(result.mirrorLogEntry);
  if (result.mirrorResult?.rebirthLogEntry) log.push(result.mirrorResult.rebirthLogEntry);
}

// Rowan's Silence Lock, same victim-turn-tick shape as poison above.
// turnsRemaining starts at 2 (silenceLock.execute) and must still be
// PRESENT in the map (so isSilenced/getLegalActions sees it) for both of
// the target's next 2 turns - so this only DELETES an already-exhausted
// (0) entry from a PRIOR tick, then decrements whatever's left. That way
// a fresh turnsRemaining=2 entry survives this character's next two
// affected turn-starts before finally being removed on the third.
function tickSilenceIfAny(character, game, log) {
  if (character.isKO) return;
  for (const caster of Object.values(game.characters)) {
    const turnsRemaining = caster.special?.silenceTargets?.get(character.id);
    if (turnsRemaining === undefined) continue;
    if (turnsRemaining <= 0) {
      caster.special.silenceTargets.delete(character.id);
      log.push({ type: 'silence-end', casterId: caster.id, targetCharacterId: character.id });
      continue;
    }
    caster.special.silenceTargets.set(character.id, turnsRemaining - 1);
  }
}

// Grimtal's Skull Crack headache: the 50% skip-chance is rolled LIVE at the
// start of the VICTIM's own next turn (confirmed ruling - not predetermined
// at cast time), then cleared immediately either way (one-shot, exactly one
// turn's worth of risk, never re-rolled). Written generically (scans every
// character's headacheVictimId rather than assuming a single Grimtal) for
// the same future-proofing reasoning as tickPoisonIfAny/tickSilenceIfAny
// above, though only Grimtal can set it today.
function resolveHeadacheIfDue(character, game, log) {
  if (character.isKO) return;
  const caster = Object.values(game.characters).find(
    (c) => c.special?.headacheVictimId === character.id && c.special.headacheRollPending
  );
  if (!caster) return;
  caster.special.headacheVictimId = null;
  caster.special.headacheRollPending = false;
  const skipped = Math.random() < 0.5;
  // Deliberately a SEPARATE flag from skipNextTurn (Chronox's Time Freeze),
  // not a shared one - gameFlow.js's frozen-skip message is hardcoded to
  // say "is frozen and skips their turn," which would be flatly wrong for
  // a headache skip. Confirmed live: reusing skipNextTurn produced both
  // "Tharox's headache flares up - turn skipped!" AND the freeze message
  // back to back, even though no freeze was ever involved. See
  // consumeSkipIfHeadache below for the matching dedicated consume path.
  if (skipped) character.skipHeadacheTurn = true;
  log.push({ type: 'headache-roll', casterId: caster.id, targetCharacterId: character.id, skipped });
}

// Grim Ward's per-cycle attacker tracking (lastHitByThisCycle) is cleared by
// Grimtal's own onTurnStart (grimtal.js) - a fresh round of "who's hit me
// since my last turn" starts there, not here.

// Runs turn-start passives for a character (shield gain, freeze flip, shield decay).
export function beginCharacterTurn(character, game, log) {
  tickPoisonIfAny(character, game, log);
  tickSilenceIfAny(character, game, log);
  resolveHeadacheIfDue(character, game, log);
  const mod = ABILITY_MODULES[character.id];
  if (mod?.onTurnStart) mod.onTurnStart(character, game, log);
  // Poison's tick above deals REAL damage outside the normal executeAction/
  // finalizeAction path (which is the only place applyEndOfActionChecks
  // normally runs) - if that tick was the killing blow on the last
  // opponent, the match needs to end right here, or it never does at all.
  // Confirmed live: everyone showed KO on the board but the game kept
  // waiting on a stale "next turn," since player.isEliminated/game.phase
  // were never recomputed after a poison-tick kill.
  applyEndOfActionChecks(game);
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
  // Rowan's Mirror Reflect counter-hit, same deferred-log-entry reasoning
  // as Athena's curse mirror above - applyDamage runs before the caller's
  // own log.push() for the triggering attack, so pushing it there would
  // land it BEFORE that attack's own line instead of after.
  if (result?.mirrorReflectLogEntry) log.push(result.mirrorReflectLogEntry);
  if (result?.mirrorReflectResult?.rebirthLogEntry) log.push(result.mirrorReflectResult.rebirthLogEntry);
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
  // 50% chance the puppet's control simply fails this turn - a genuine
  // gamble every single puppeted action, specials included, no exceptions
  // (confirmed ruling). On a fail, the puppet does nothing at all - no
  // fallback action, the whole turn is just wasted - and a dedicated
  // 'mind-control-resist' entry is pushed instead of ever calling
  // executeAction, so the puppet's own ability never actually runs (no
  // partial effects, no side effects at all from the attempted action).
  if (Math.random() < 0.5) {
    // controllingMelyssaId stamped directly on the entry (not post-hoc via
    // array indexing) for consistency with how a successful puppeted
    // action gets it below - client-side flash logic keys on this field.
    const log = [{
      type: 'mind-control-resist', characterId: melyssaCharacterId, puppetCharacterId, actionId,
      controllingMelyssaId: melyssaCharacterId,
    }];
    finalizeAction(game, log, {}, puppetCharacterId, actionId, targetId);
    return {};
  }
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

// Grimtal's Skull Crack headache - same consume-and-clear shape as
// consumeSkipIfFrozen above, but its own dedicated flag (see
// resolveHeadacheIfDue) so gameFlow.js can show its own distinct skip
// message instead of the freeze-specific one.
export function consumeSkipIfHeadache(character) {
  if (character.skipHeadacheTurn) {
    character.skipHeadacheTurn = false;
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
