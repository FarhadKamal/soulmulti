import { cloneGame } from './state.js';
import { applyDamage, applyHeal, applyShield, isSilenced, isFrozenByChronox, heartsSnapshot, decayAllDueShields } from './damagePipeline.js';
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
import * as oraclus from '../abilities/oraclus.js';

const ABILITY_MODULES = { chronox, tharox, zerathys, akyros, velorya, boingo, blade, athena, melyssa, kaelis, draxus, rowan, marin, grimtal, illyra, oraclus };

// Boingo's Fowl Play - the chicken window lasts until Boingo has had this
// many of his OWN turns since casting (his cast turn itself doesn't
// count) - confirmed ruling, fixed 2026-09-03 after a flat global-move-
// count version closed the window right before Boingo's own next turn in
// a 4-player match, so he never got a real chance to attack a chicken
// himself. Ticked in beginCharacterTurn below, once each time Boingo's
// own turn begins while game.fowlPlayActive is true.
export const FOWL_PLAY_BOINGO_TURNS = 3;
// Every 2nd cumulative hit a chicken lands on Boingo actually deals
// damage - the alternating hit deals 0 (confirmed ruling). A GLOBAL
// counter (game.fowlPlayHitsOnBoingo), not per-attacker.
export const FOWL_PLAY_BOINGO_HIT_INTERVAL = 2;

export function getAbilityModule(characterId) {
  return ABILITY_MODULES[characterId];
}

// True while this character is chickenified by Boingo's Fowl Play - a
// plain boolean flag createCharacter puts directly on every character
// (see state.js), same pattern as skipNextTurn/skipHeadacheTurn.
export function isChickenified(character) {
  return !!character && character.isChicken;
}

// Boingo's Fowl Play - while chickenified, EVERY one of a character's own
// actions (Normal/Special/Neutral/Passive, whatever their hero kit
// normally offers) is replaced by this single synthetic action. Not
// declared in any abilities/<id>.js file (chicken status is a
// character-agnostic override, not part of any one hero's own kit) -
// getLegalActions below short-circuits straight to this before ever
// consulting ABILITY_MODULES, which is also why this needs no `hidden`
// flag of its own (it's never reached through the normal mod.actions
// path at all).
const CHICKEN_ATTACK_ACTION = {
  label: 'Chicken Attack',
  needsTarget: true,
  isLegal: () => true,
};

export function getLegalActions(character, game) {
  if (isChickenified(character)) {
    return [{ actionId: 'chickenAttack', ...CHICKEN_ATTACK_ACTION }];
  }
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
  // Boingo's Fowl Play - Chicken Attack has its own targeting rule
  // entirely separate from the generic enemy-only rule below: a chicken
  // may target any OTHER living chicken (regardless of owner - there are
  // no teams in this game anyway) or Boingo himself specifically
  // (confirmed ruling: "chicken can only attack another chicken" + "only
  // boingo can attack other"). Checked before the generic ownerId/
  // untargetable checks since neither applies to this action - a chicken
  // can and must be able to hit Boingo even though he's the one who
  // caused this whole thing, and untargetable status is irrelevant here
  // since no chickenified character retains any status-granting kit
  // anyway (everything's hidden while chickenified).
  if (actionId === 'chickenAttack') {
    if (targetId === characterId) return false;
    if (targetId === 'boingo') return true;
    return isChickenified(target);
  }
  if (target.ownerId === character.ownerId) return false;
  if (target.untargetable) return false;
  if (actionId === 'shadowExecution') return character.special.marks.has(targetId);
  if (actionId === 'hiddenMark') return !character.special.everMarkedIds.has(targetId);
  // Chronox's Rewind lockout: the caster it was cast against cannot use
  // that EXACT SAME action against Chronox specifically, for their own
  // next turn only (see tickChronoxLockoutIfAny for the timing). Every
  // OTHER action against Chronox, and this exact action against anyone
  // else, remain fully legal - only this one precise (caster, action,
  // Chronox) combination is blocked.
  if (targetId === 'chronox') {
    const chronoxChar = game.characters.chronox;
    if (chronoxChar && chronoxChar.special.lockedActionCasterId === characterId
      && chronoxChar.special.lockedActionId === actionId) {
      return false;
    }
  }
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
  const character = game.characters[targetId];
  return !!character && isFrozenByChronox(character, game);
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

// Oraclus's Rune Vision stage 1 (picking the predicted ATTACKER) - same
// "needs its own dedicated function, not a per-actionId bypass in
// isValidTarget" reasoning as Mind Control above, since predicting who
// will attack whom genuinely needs to allow ANY living character
// (including allies) as the predicted attacker, never just enemies. He can
// never predict HIMSELF as the attacker (confirmed ruling - "predicting an
// opponent," not forecasting his own move).
export function isValidRuneVisionAttackerPick(game, targetId) {
  const target = game.characters[targetId];
  if (!target || target.id === 'oraclus') return false;
  if (target.isKO || target.untargetable) return false;
  return true; // deliberately no ownerId check - any living character but himself
}

// Stage 2 (picking the predicted TARGET) - unlike the attacker pick, he CAN
// predict himself as the target (confirmed ruling: "yes, he can predict
// himself as the target too"). The only hard exclusion is the already-
// chosen predicted attacker itself (an attacker can't "attack" themselves
// in this game - no self-targeted damaging action exists in the roster).
export function isValidRuneVisionTargetPick(game, predictedAttackerId, targetId) {
  if (targetId === predictedAttackerId) return false;
  const target = game.characters[targetId];
  if (!target) return false;
  if (target.isKO || target.untargetable) return false;
  return true;
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
  // Chronox's Rewind lockout applies here too - a puppeted attacker is
  // still the same underlying character the lock is keyed on, so forcing
  // them into it via Mind Control shouldn't bypass the restriction.
  if (targetId === 'chronox') {
    const chronoxChar = game.characters.chronox;
    if (chronoxChar && chronoxChar.special.lockedActionCasterId === puppetId
      && chronoxChar.special.lockedActionId === actionId) {
      return false;
    }
  }
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
    // Oraclus's Rune Vision is excluded from Mind Control entirely - it's
    // a two-stage SELECTION move (targets via isValidRuneVisionAttackerPick,
    // ally-allowed, not the enemy-only isValidPuppetTarget this function
    // otherwise checks against), and thematically Mind Control forces real
    // attacks/self-harm, not a passive prediction setup. Puppeting him into
    // it would need its own dedicated stage-2 handling (mirroring Soul
    // Swap's puppeted follow-up) for a move that deals no damage and poses
    // no threat when forced - not worth the added complexity.
    if (action.actionId === 'runeVision') return false;
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
  log.push({ type: 'poison-tick', casterId: caster.id, targetCharacterId: character.id, ...result, hearts: heartsSnapshot(game) });
  // Same deferred-log-entry handling as finalizeAction: applyDamage returns
  // curse-mirror/rebirth entries on the result rather than pushing them
  // itself, so a poison tick that kills a cursed Athena (mirroring damage
  // onto her cursed target) needs this path to push them too, or that
  // mirror hit happens with no corresponding log line at all.
  if (result.rebirthLogEntry) log.push({ ...result.rebirthLogEntry, hearts: heartsSnapshot(game) });
  if (result.mirrorLogEntry) log.push({ ...result.mirrorLogEntry, hearts: heartsSnapshot(game) });
  if (result.mirrorResult?.rebirthLogEntry) log.push({ ...result.mirrorResult.rebirthLogEntry, hearts: heartsSnapshot(game) });
  // Boingo's Fowl Play - same deferred handling: a poison tick that kills
  // him needs to push this AFTER its own 'poison-tick' line above,
  // otherwise the revert announcement lands before the very hit that
  // caused it (confirmed bug, 2026-09-03: "Tharox, Rowan turn back into
  // heroes!" appeared BEFORE "Boingo takes 1 poison damage - KO!" in a
  // real match log).
  if (result.fowlPlayRevertLogEntry) log.push({ ...result.fowlPlayRevertLogEntry, hearts: heartsSnapshot(game) });
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
      log.push({ type: 'silence-end', casterId: caster.id, targetCharacterId: character.id, hearts: heartsSnapshot(game) });
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
  log.push({ type: 'headache-roll', casterId: caster.id, targetCharacterId: character.id, skipped, hearts: heartsSnapshot(game) });
}

// Grim Ward's per-cycle attacker tracking (lastHitByThisCycle) is cleared by
// Grimtal's own onTurnStart (grimtal.js) - a fresh round of "who's hit me
// since my last turn" starts there, not here.

// Runs turn-start passives for a character (shield gain, freeze flip, shield decay).
// Chronox's Rewind lockout: unlike every other status-tracking field in
// this file, this one lives on CHRONOX'S OWN special (lockedActionCasterId
// points AT the restricted caster) rather than on the restricted caster's
// own special pointing back at Chronox - simpler here since there's only
// ever one active lock at a time (Rewind is 1-use total) and no need to
// scan every character the way tickSilenceIfAny does.
//
// lockedActionTurnsRemaining starts at 1 the instant Rewind resolves. This
// tick fires at the START of the LOCKED CASTER's own turn (character.id
// here is whoever's turn is starting, not Chronox) - a two-phase
// check-then-consume, NOT a simple decrement-and-check-in-the-same-pass,
// because isValidTarget (later in this SAME turn) still needs to see the
// lock as active for the caster's very next turn: if this tick both
// decremented to 0 AND deleted the lock in one pass, the restriction would
// never actually apply on the turn it's meant to cover.
// - First sighting (turnsRemaining === 1, their genuine "next turn"):
//   decrement to 0, but KEEP the lock in place - isValidTarget still
//   blocks the exact locked action against Chronox for the rest of this
//   turn.
// - Second sighting (turnsRemaining === 0, meaning their turn after that
//   has now arrived and the restricted turn is fully over): clear the
//   lock entirely, restoring their normal options from here on.
// Deliberately NOT called from beginCharacterTurn like the other tick
// functions above - unlike poison/silence/headache (which all need to fire
// every round a character's turn comes up regardless of whether they end up
// frozen/skipped, per beginCharacterTurn's own unconditional-firing
// rationale in gameFlow.js), this lockout is specifically meant to cover
// one turn where the caster actually GETS to act. beginCharacterTurn fires
// before the freeze/headache skip checks in getActingCharacterId, so if
// this lived there, a frozen or headache-skipped "turn" would silently
// consume the lockout countdown without the caster ever having a real turn
// restricted by it - confirmed live: Chronox froze Melyssa right after
// Rewinding her Self Choke, both frozen turns ticked the lock down to 0,
// and she Self Choked him again completely unrestricted on her next REAL
// turn. Called explicitly from gameFlow.js instead, only once a character
// is confirmed to be getting a genuine turn (past both skip checks).
export function tickChronoxLockoutIfAny(character, game, log) {
  const chronoxChar = game.characters.chronox;
  if (!chronoxChar || chronoxChar.isKO) return;
  if (chronoxChar.special.lockedActionCasterId !== character.id) return;
  if (chronoxChar.special.lockedActionTurnsRemaining > 0) {
    chronoxChar.special.lockedActionTurnsRemaining -= 1;
    return;
  }
  chronoxChar.special.lockedActionCasterId = null;
  chronoxChar.special.lockedActionId = null;
}

// Boingo's Fowl Play - only fires when the character whose turn is
// STARTING is Boingo himself (a no-op for everyone else's turns), and
// only while game.fowlPlayActive is true. Increments
// fowlPlayBoingoTurnsElapsed once; once it reaches FOWL_PLAY_BOINGO_TURNS
// (3), the whole window ends - EVERY currently-chickenified character
// reverts simultaneously (confirmed ruling, 2026-09-03: "wait for boingo
// three turn atleast then cast will stop and everyone become hero"). The
// turn during which Fowl Play was CAST doesn't count toward this - that
// cast happens mid-execute, not at a beginCharacterTurn boundary, so this
// hook is never reached for the cast turn itself, only for turns that
// begin AFTER it.
function tickFowlPlayIfBoingoTurn(character, game, log) {
  if (character.id !== 'boingo' || !game.fowlPlayActive) return;
  game.fowlPlayBoingoTurnsElapsed += 1;
  if (game.fowlPlayBoingoTurnsElapsed >= FOWL_PLAY_BOINGO_TURNS) {
    game.fowlPlayActive = false;
    game.fowlPlayBoingoTurnsElapsed = 0;
    const revertedIds = [];
    for (const c of Object.values(game.characters)) {
      if (c.isChicken) {
        c.isChicken = false;
        revertedIds.push(c.id);
      }
    }
    if (revertedIds.length > 0) {
      log.push({ type: 'fowl-play-revert', characterIds: revertedIds, hearts: heartsSnapshot(game) });
    }
  }
}

export function beginCharacterTurn(character, game, log) {
  // Decay due shields before anything else this turn (poison ticks
  // included) - see decayAllDueShields's own comment for why this must run
  // first, not just before this character's own onTurnStart.
  decayAllDueShields(game);
  tickPoisonIfAny(character, game, log);
  tickSilenceIfAny(character, game, log);
  resolveHeadacheIfDue(character, game, log);
  tickFowlPlayIfBoingoTurn(character, game, log);
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

// Chronox's Rewind: records a full snapshot of every character's state
// (plus game.jesterBall) IMMEDIATELY BEFORE any action that directly
// targets him resolves. Deliberately generic/game-agnostic rather than
// hand-writing per-ability undo logic (see the detailed reasoning in
// state.js's chronox special-field comments) - this single hook is what
// makes Rewind work correctly for every kind of effect in the game
// uniformly (plain damage, statuses, Soul Swap's heart-swap, Illyra's
// Mirage Burst, Jester Ball state), with zero changes needed to any other
// ability file. Only records when targetId === 'chronox' specifically
// (the caster's own self-only actions, or actions aimed at someone else,
// never count as "an action against him") - deliberately does NOT try to
// capture indirect cascades like a curse-mirror landing on him from
// someone else's attack, since "the most recent action taken against him"
// naturally means the most recent time he was the ACTUAL chosen target.
// Two-phase: this only BUILDS a candidate record and returns it (or a
// sentinel/null) - committing it to chronoxChar.special.lastActionAgainstMe
// is executeAction's job, below, AFTER the action has actually resolved and
// its real effect on Chronox is known. See executeAction's own comment for
// why the commit is conditional: a fully shield-absorbed hit (0 net
// effect - the shield decays back to the same value on his own next turn
// regardless) was otherwise a free, repeatable way to overwrite a
// genuinely valuable pending Rewind record for nothing ("shield-tap
// griefing," confirmed via audit).
//
// Returns: null (nothing to record - wrong target or Chronox already KO'd),
// 'keep-existing' (still mid-combo with the CURRENTLY COMMITTED record -
// caller must not touch lastActionAgainstMe at all, whether or not this
// individual call ends up dealing damage), or a fresh record object ready
// to commit pending the post-execute effect check.
export function buildActionAgainstChronoxRecord(game, characterId, actionId, targetId) {
  if (targetId !== 'chronox') return null;
  // Oraclus's Rune Vision (stage 1) is a SELECTION, not an attack - picking
  // Chronox as the predicted ATTACKER genuinely sets targetId: 'chronox'
  // (it reuses the normal single-target picker), but it deals no damage
  // and doesn't act ON him at all, the same way Melyssa's mindControl
  // puppet-selection targeting Chronox doesn't either. Without this
  // exclusion, casting Rune Vision naming Chronox as the predicted
  // attacker would get recorded as "the most recent action against him,"
  // and a later real hit on him could be masked/overwritten incorrectly by
  // it (or, worse, be silently dropped the way the mindControl bug was) -
  // confirmed reachable via direct testing when this character was added.
  if (actionId === 'runeVision') return null;
  // Melyssa's mindControl (puppet SELECTION, not an attack) gets the exact
  // same treatment as runeVision above, for the same underlying reason -
  // picking Chronox AS THE PUPPET genuinely sets targetId: 'chronox', but
  // selecting him deals no damage and doesn't act on him at all. The
  // original fix for this (the "same combo" exclusion further below,
  // matching on lastActionAgainstMe?.actionId !== 'mindControl') only
  // prevented a LATER action from being wrongly merged into an EXISTING
  // mindControl record - it never stopped mindControl from being recorded
  // as the first/only record in the first place, which is wrong on its
  // own even before any follow-up action happens (confirmed via direct
  // regression testing after Oraclus's runeVision fix was added
  // alongside it, exposing that this exact gap was never actually closed).
  if (actionId === 'mindControl') return null;
  const chronoxChar = game.characters.chronox;
  if (!chronoxChar || chronoxChar.isKO) return null;
  // Generalized "still the same combo" guard. Several characters chain
  // MULTIPLE separate executeAction calls against Chronox within what is
  // conceptually one continuous turn: Soul Swap's free Thunder Wrath
  // follow-up (soulSwapWrath, fired as a second executeAction right after
  // soulSwap), and Draxus's Deathless Fury bonus turn (3 separate Dying
  // Blow strikes, index.js deliberately withholds markCharacterActed
  // between them - see its own comment there). If EACH of those calls
  // re-recorded here, only the LAST one in the chain would survive to be
  // Rewound - Zerathys's usedSpecial (spent by soulSwap, untouched by
  // soulSwapWrath) never got refunded, and a Rewound Draxus combo only
  // undid his 3rd strike while keeping strikes 1-2's damage AND leaking his
  // spent bonusActionsRemaining back onto his object. Both confirmed live/
  // via audit as real, not-rare gaps.
  //
  // Fix: detect "still mid-combo" via game.turnInstanceFor (gameFlow.js), a
  // monotonically increasing per-character counter bumped once at the
  // START of each of the caster's own genuinely new turns, never reset.
  // (hasCharacterActedThisTurn was tried first and rejected - it's false
  // at the START of every turn too, indistinguishable from "still
  // mid-combo," so it wrongly kept an old record forever across an entire
  // new later turn's first hit in testing.) Same caster + same
  // turnInstanceFor value as the CURRENTLY COMMITTED record means this
  // action is still part of that same turn's combo - keep the original
  // snapshot untouched (taken before the combo's very first strike, i.e.
  // before ALL of the combo's damage/effects) regardless of how much (if
  // any) damage THIS individual strike deals, so Rewind correctly reverses
  // the WHOLE combo at once. A different turnInstanceFor value means a
  // genuinely new turn's first hit, which SHOULD build a fresh record.
  // Melyssa's mindControl (puppet SELECTION, not an attack) is deliberately
  // excluded from ever counting as an existing combo to continue from, even
  // though it's a real, distinct recordable action against Chronox in its
  // own right (she can target him AS the puppet, targetId === 'chronox').
  // Without this exclusion, her very next action that same turn - Self
  // Choke, or a puppeted real attack - would be wrongly treated as "still
  // the same combo" as the selection step and silently dropped/merged
  // instead of properly overwriting it, since both share her one
  // turnInstance. Confirmed live: "Chronox used Rewind - undid Melyssa's
  // mindControl!" fired instead of undoing the actual Self Choke damage
  // that followed moments later - the selection step's harmless 0-damage
  // snapshot was kept instead of being replaced.
  const turnInstance = game.turnInstanceFor.get(characterId);
  if (
    chronoxChar.special.lastActionAgainstMe?.casterId === characterId
    && chronoxChar.special.lastActionAgainstMe?.casterTurnInstance === turnInstance
    && chronoxChar.special.lastActionAgainstMe?.actionId !== 'mindControl'
  ) {
    return 'keep-existing';
  }
  // Deliberately snapshots ONLY the caster's own character object, Chronox
  // himself, game.jesterBall, and (see below) Grimtal's/Kaelis's own kill/
  // grudge counters - NOT the entire game.characters map. Restoring every
  // character's full state wholesale would incorrectly undo everyone ELSE's
  // unrelated progress too (their own damage dealt, resources spent, etc.)
  // if other turns happened between the recorded action and Chronox
  // actually casting Rewind - clearly wrong for an ability that's meant to
  // reverse ONE specific past action, not rewind the whole match. Every
  // effect type in the game that could plausibly target Chronox only ever
  // touches the caster's own state and/or Chronox's own state (plain
  // damage, curse/freeze/mark/silence/headache statuses live on the
  // caster's special; Soul Swap only swaps hearts between caster and
  // target; Illyra's Mirage Burst's stack map lives on the caster) plus,
  // for Jester Ball specifically, the single shared game.jesterBall slot -
  // covered separately below since it isn't scoped to any one character.
  //
  // Grimtal's ownKillCount/unclaimedKillCount and Kaelis's grudgeCounts are
  // the two known EXCEPTIONS to "only caster + Chronox" - both are
  // incremented generically inside applyDamage's own KO-branch/damage-
  // landed logic, triggered by ANY damage source (not just Chronox-directed
  // ones), so an action recorded against Chronox can indirectly cause a
  // side effect on these two THIRD-PARTY characters within the same
  // execute() call - e.g. Athena's Divine Sacrifice on Chronox, followed by
  // her own self-cost damage triggering a curse-mirror onto Kaelis (grudge
  // point) or KO'ing a cursed target (Grimtal's banked kill). Confirmed via
  // audit as reachable and real - without this, Rewind would undo the
  // recorded action but leave Grimtal/Kaelis permanently keeping a kill/
  // grudge point for an event that no longer happened. Snapshotting them
  // alongside the caster+Chronox (when present/alive) closes this without
  // needing to detect/special-case every possible chain generically.
  const grimtalChar = game.characters.grimtal;
  const kaelisChar = game.characters.kaelis;
  return {
    casterId: characterId,
    casterTurnInstance: turnInstance,
    actionId,
    casterSnapshot: structuredClone(game.characters[characterId]),
    chronoxSnapshot: structuredClone(chronoxChar),
    jesterBallSnapshot: structuredClone(game.jesterBall),
    grimtalKillCounts: grimtalChar && !grimtalChar.isKO
      ? { ownKillCount: grimtalChar.special.ownKillCount, unclaimedKillCount: grimtalChar.special.unclaimedKillCount }
      : null,
    kaelisGrudgeCounts: kaelisChar && !kaelisChar.isKO
      ? structuredClone(kaelisChar.special.grudgeCounts)
      : null,
  };
}

// Generic, per-ability-agnostic "did this action have a real effect worth
// recording" check - a hit is worth committing if it dealt real HEART
// damage or KO'd Chronox (shield alone is deliberately excluded: Chrono
// Guard resets his shield to exactly 1 every one of his own turns
// regardless, so absorbing 1 point of shield is not a meaningful loss worth
// spending a valuable pending Rewind record on - it's exactly the
// "shield-tap griefing" scenario this whole check exists to stop, confirmed
// ruling). ALSO worth recording if the CASTER's own object changed at all
// (deep-equal against their pre-action snapshot) - this is what makes a
// pure 0-damage status action (Curse Strike, Time Freeze, Hidden Mark,
// Silence Lock, Mirage Mark, Skull Crack's headache roll) still count:
// every one of those effects lives entirely on the CASTER's own .special,
// never on Chronox's own object, so checking only Chronox's state would
// wrongly treat them as "no real effect" and silently drop them - confirmed
// as a real regression during testing (Curse Strike stopped being recorded
// at all once shield-only changes were excluded).
export function chronoxStateActuallyChanged(chronoxChar, chronoxSnapshot, caster, casterSnapshot) {
  const chronoxHeartsChanged = chronoxChar.hearts !== chronoxSnapshot.hearts || chronoxChar.isKO !== chronoxSnapshot.isKO;
  if (chronoxHeartsChanged) return true;
  if (!caster || !casterSnapshot) return false;
  return !deepEqual(caster, casterSnapshot);
}

// Plain recursive deep-equal that understands Map/Set (several characters'
// .special fields use them - Illyra's mirageMarks, Rowan's
// discoveredSpells, Kaelis's grudgeCounts, Rowan's silenceTargets, Akyros's
// marks/revealedMarks/everMarkedIds - so JSON.stringify, which silently
// serializes any Map/Set as {}, would wrongly treat a Map/Set-only change
// as "no change at all"). Good enough for character objects specifically
// (plain values, arrays, Maps, Sets, nested plain objects - no functions,
// no circular references, matches everything actually stored on
// character.special across the whole roster).
function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// Illyra's Mirage Burst is needsTarget: false (one click detonates EVERY
// currently-marked enemy at once - see illyra.js) - executeAction's normal
// recordActionAgainstChronoxIfApplicable(..., targetId) call is a no-op for
// it, since targetId is always undefined/null for a no-target action, so a
// burst that genuinely hits Chronox was never recorded at all, leaving him
// unable to Rewind his own biggest incoming hit from her kit. Confirmed via
// audit as a real, not-rare gap - Mirage Mark stacking Chronox specifically
// is an obvious, common line of play against him. Resolved generically
// here (not inside illyra.js) to avoid a circular import (illyra.js is
// itself imported BY this file); mirrors resolveJesterBall's own "no single
// upfront targetId, so read the caster's own pre-existing state directly"
// pattern - marks bypass dodge entirely (ignoresDodge: true in illyra.js),
// so a positive stack count is a guaranteed hit, not just a possible one.
function mirageBurstTargetsChronox(game, characterId, actionId) {
  if (actionId !== 'mirageBurst') return false;
  const caster = game.characters[characterId];
  return (caster?.special.mirageMarks?.get('chronox') || 0) > 0;
}

// Tharox's Earthshatter is also needsTarget: false, but unlike Mirage
// Burst there's no pre-existing per-target state to check in advance -
// WHO gets hit is decided by fresh randomness inside execute() itself, so
// there's no way to know beforehand whether Chronox will be among the
// victims. Rather than trying to predict it, treat every Earthshatter
// cast (while Chronox is alive) as a candidate "action against Chronox"
// unconditionally - this is safe because buildActionAgainstChronoxRecord/
// chronoxStateActuallyChanged's own two-phase commit (see executeAction)
// already only actually saves the record if Chronox's own state (or the
// caster's) demonstrably changed afterward. A cast that happens to miss
// him entirely just produces a candidate that gets built and then
// silently discarded post-execute, same as any other 0-effect hit -
// exactly the "shield-tap griefing" guard this two-phase design already
// exists for, just reused here for "no-effect-at-all" instead of
// "fully-absorbed."
function earthshatterMayTargetChronox(game, characterId, actionId) {
  if (actionId !== 'earthshatter') return false;
  const chronoxChar = game.characters.chronox;
  return !!chronoxChar && !chronoxChar.isKO;
}

// Oraclus's Rune Vision: checks a pending prediction against the VERY NEXT
// genuine attack anyone takes (see oraclus.js's runeVision.execute for how
// the guess itself is stored) - written generically here in turnEngine.js,
// not oraclus.js, for the same reason Chronox's Rewind recording lives here
// (this needs to see EVERY action in the game, by any character, not just
// ones that target Oraclus - a circular import concern if it lived in his
// own ability file, since this file imports every ability module).
//
// "A real attack" (confirmed ruling): the action must be capable of
// dealing damage to the target - i.e. it routed through applyDamage at all
// - even if shield fully absorbed it or a dodge mechanic blocked it
// entirely (0 amountDealt still counts, since he's predicting the ATTACK
// CHOICE, not the outcome). A pure 0-damage setup/status move (Arcane
// Study, Poison Cloud's cast, Hidden Mark, Time Freeze, Silence Lock, Soul
// Swap) never calls applyDamage at all and returns a plain {} - the
// presence of a numeric amountDealt on the result is what distinguishes a
// genuine attack attempt from a setup move generically, without needing to
// hardcode every action id in the game.
//
// Deliberately does NOT clear the pending prediction on a skip (frozen/
// headache/no-valid-target) - those never reach this function at all
// (gameFlow.js's getActingCharacterId marks a skipped character acted
// without ever calling executeAction), so the guess correctly keeps
// waiting through skips for the predicted attacker's next REAL action, per
// the confirmed ruling.
// `log` is the CALLER's own local array (the same one their action's own
// attack/special entry gets pushed into) - NOT game.log directly. Pushing
// straight to game.log here would land the prediction-result entry BEFORE
// the triggering attack's own entry, since the caller's local `log` isn't
// appended to game.log until finalizeAction runs, afterward. Confirmed
// live bug: with the reveal entry landing first, the client processed it
// (and its move-priority win/loss voice line) before the attacker's own
// move-voice - the two tied on priority, and whichever processed SECOND
// (the attacker's own line) cut the first one off via the arbitration
// window's tie-break rule, so the win/loss voice was audible for barely an
// instant before being silenced. Pushing into the shared local `log`
// array instead guarantees the reveal is ordered AFTER the attack that
// caused it, both in the log AND in client-side voice arbitration.
export function resolveOraclusPredictionIfPending(game, log, characterId, actionId, targetId, result) {
  const oraclusChar = game.characters.oraclus;
  if (!oraclusChar || oraclusChar.isKO) return;
  if (!oraclusChar.special.predictedAttackerId) return;
  // Only ever resolves against the PREDICTED attacker's own action - any
  // other character acting in between (including Oraclus himself) is
  // simply irrelevant noise, not a miss - the guess is specifically about
  // that one character's NEXT action, wherever it falls in turn order.
  if (characterId !== oraclusChar.special.predictedAttackerId) return;
  if (!result || typeof result.amountDealt !== 'number') return;
  const isMatch = targetId === oraclusChar.special.predictedTargetId;
  oraclusChar.special.predictedAttackerId = null;
  oraclusChar.special.predictedTargetId = null;
  if (!isMatch) {
    log.push({ type: 'prediction-result', characterId: 'oraclus', matched: false, hearts: heartsSnapshot(game) });
    return;
  }
  oraclusChar.special.predictionWins += 1;
  oraclusChar.special.runeStrikeBonusDamage += 1;
  applyHeal(game, 'oraclus', 3);
  applyShield(game, 'oraclus', 3, { decaying: false });
  log.push({
    type: 'prediction-result', characterId: 'oraclus', matched: true,
    predictedAttackerId: characterId, predictedTargetId: targetId,
    predictionWins: oraclusChar.special.predictionWins,
    hearts: heartsSnapshot(game),
  });
}

// Boingo's Fowl Play - Chicken Attack's own execute, dispatched specially
// in executeAction below since it's not a real entry in any ability
// module's `actions` map (it's a character-agnostic override, see
// CHICKEN_ATTACK_ACTION/getLegalActions above). Confirmed rules:
// - Chicken vs. chicken: always flat 1 damage, ZERO defense of ANY kind
//   ("NO SHIELD NO DODGE NO UNTERGATABBLE NO IMMORTAL during chicken
//   status" + "not even rebirth possible"). This is now enforced
//   AUTOMATICALLY by applyDamage itself (damagePipeline.js forces every
//   ignores* flag true whenever target.isChicken is true) - no flags need
//   passing here for that case.
// - Chicken vs. Boingo: uses game.fowlPlayHitsOnBoingo, a GLOBAL
//   cumulative counter shared across every attacking chicken (not
//   per-attacker) - every 2nd cumulative hit lands 1 damage, the
//   alternating hit deals 0. Boingo himself is NEVER chickenified, so
//   applyDamage's own target.isChicken bypass does NOT apply to him -
//   confirmed ruling (2026-09-04, after a real bug: his shield stayed
//   frozen at the same value across several actual landed hits, since
//   this function used to pass ignoresShield/ignoresDodge/etc.
//   UNCONDITIONALLY regardless of target): the landing hit on Boingo
//   respects his normal shield/dodge like any other genuine attack -
//   deliberately NOT passing any ignores* flags here lets his real
//   defenses apply normally.
function executeChickenAttack(character, targetId, game, log) {
  let amount;
  if (targetId === 'boingo') {
    game.fowlPlayHitsOnBoingo += 1;
    amount = (game.fowlPlayHitsOnBoingo % FOWL_PLAY_BOINGO_HIT_INTERVAL === 0) ? 1 : 0;
  } else {
    amount = 1;
  }
  const result = applyDamage(game, log, {
    sourceCharacterId: character.id,
    targetCharacterId: targetId,
    amount,
  });
  log.push({ type: 'attack', characterId: character.id, actionId: 'chickenAttack', targetId, ...result });
  return result;
}

export function executeAction(game, characterId, actionId, targetId, extra) {
  const effectiveTargetId = (mirageBurstTargetsChronox(game, characterId, actionId) || earthshatterMayTargetChronox(game, characterId, actionId))
    ? 'chronox' : targetId;
  const candidateRecord = buildActionAgainstChronoxRecord(game, characterId, actionId, effectiveTargetId);
  const character = game.characters[characterId];
  const log = [];
  let result;
  if (actionId === 'chickenAttack') {
    result = executeChickenAttack(character, targetId, game, log);
  } else {
    const mod = ABILITY_MODULES[characterId];
    const actionDef = mod.actions[actionId];
    result = actionDef.execute(character, targetId, game, log, extra);
  }
  resolveOraclusPredictionIfPending(game, log, characterId, actionId, targetId, result);
  // Commit the candidate record AFTER execute has actually run, and only
  // if it's a genuinely fresh record (not 'keep-existing'/null) whose
  // action had a REAL effect on Chronox - see
  // buildActionAgainstChronoxRecord/chronoxStateActuallyChanged's own
  // comments for why (shield-tap griefing fix, confirmed ruling). A
  // 'keep-existing' combo-continuation never touches lastActionAgainstMe
  // at all, regardless of this individual call's own effect.
  if (candidateRecord && candidateRecord !== 'keep-existing') {
    const chronoxChar = game.characters.chronox;
    if (chronoxChar && chronoxStateActuallyChanged(chronoxChar, candidateRecord.chronoxSnapshot, character, candidateRecord.casterSnapshot)) {
      chronoxChar.special.lastActionAgainstMe = candidateRecord;
    }
  }
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
  // mirror's own entry is queued, the mirror result too. Deliberately NOT
  // stamped with their own hearts here (unlike the standalone sites this
  // whole hearts-snapshot fix targets) - `log` is always this action's own
  // execute()-local batch array (confirmed: every finalizeAction caller
  // passes a local array, never game.log directly), always immediately
  // followed by this SAME batch's single shared end-action push below,
  // which already carries the correct final snapshot. Stamping these too
  // would make the client's own "stop at the first hearts-bearing entry"
  // fallback scan incorrectly treat them as a new standalone boundary,
  // cutting the PRECEDING attack line off from ever reaching this batch's
  // real end-action - confirmed as a real regression caught by testing.
  if (result?.rebirthLogEntry) log.push(result.rebirthLogEntry);
  if (result?.mirrorLogEntry) log.push(result.mirrorLogEntry);
  if (result?.mirrorResult?.rebirthLogEntry) log.push(result.mirrorResult.rebirthLogEntry);
  // Rowan's Mirror Reflect counter-hit, same deferred-log-entry reasoning
  // as Athena's curse mirror above - applyDamage runs before the caller's
  // own log.push() for the triggering attack, so pushing it there would
  // land it BEFORE that attack's own line instead of after.
  if (result?.mirrorReflectLogEntry) log.push(result.mirrorReflectLogEntry);
  if (result?.mirrorReflectResult?.rebirthLogEntry) log.push(result.mirrorReflectResult.rebirthLogEntry);
  // Boingo's Fowl Play - deferred the same way as rebirthLogEntry above
  // (see boingo.js's own registerOnOwnDeath comment for why this can't be
  // pushed directly inside the callback). No hearts snapshot stamped here,
  // same reasoning as every other entry in this block - the very next line
  // (end-action) already carries the correct final one.
  if (result?.fowlPlayRevertLogEntry) log.push(result.fowlPlayRevertLogEntry);
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
  // Jester Ball explosions (Take, or an un-intercepted 5th Pass) can deal
  // real damage to whoever's currently holding it - Chronox's Rewind needs
  // to see this too, but there's no single upfront targetId to check the
  // way executeAction's own recordActionAgainstChronoxIfApplicable does
  // (a Pass might just move the ball with no explosion at all). Snapshot
  // unconditionally before resolving (cheap - same structuredClone cost as
  // every other snapshot in this file), then only actually record it
  // against Chronox if the holder turns out to be him once resolution is
  // known.
  const isChronoxHolder = holderCharacterId === 'chronox' && !game.characters.chronox?.isKO;
  // Deliberately NO caster/casterId at all here (unlike every other
  // recorded action) - the "caster" for a Jester Ball explosion is
  // ambiguous by nature (the ORIGINAL thrower, from turns earlier, chose
  // none of this: whether it explodes on Chronox depends on who passed it
  // to him, an auto-resolving 5th pass, or Chronox's own Take/frozen-forced
  // Take). Originally this recorded thrownByCharacterId as casterId and
  // restored their WHOLE object on Rewind - but that object is never
  // actually mutated by an explosion landing on Chronox (only
  // game.jesterBall and Chronox's own hearts change), so there was nothing
  // to legitimately restore there in the first place. Worse, if that same
  // thrower threw a SECOND ball before Chronox got around to Rewinding the
  // first explosion, restoring their stale object rolled jesterBallsUsed/
  // usedSpecial backward and resurrected the first ball's already-resolved
  // state into game.jesterBall, corrupting the second throw entirely -
  // confirmed reachable via audit. Also, the resulting lockout named the
  // thrower for a `jesterBall:take`/`jesterBall:pass` action pair that
  // nothing in this file's own Jester Ball resolution path ever checks, so
  // it was pure dead weight. Fix: record no caster and no lockout for this
  // case - Rewind still fully undoes Chronox's own damage and restores
  // game.jesterBall (see chronox.js's rewind.execute, which now branches on
  // casterId === null to skip the caster-object restore and lockout steps
  // entirely for this action).
  const preSnapshot = isChronoxHolder
    ? {
      casterId: null,
      actionId: `jesterBall:${choice}`,
      chronoxSnapshot: structuredClone(game.characters.chronox),
      jesterBallSnapshot: structuredClone(game.jesterBall),
    }
    : null;
  const result = res.execute(game, log, extra);
  // Only commit the snapshot if the ball resolution actually did something
  // to Chronox himself (hearts/isKO changed) - same "shield-tap griefing"
  // two-phase guard buildActionAgainstChronoxRecord/chronoxStateActually
  // Changed already use for every other action in the game, just applied
  // here too. Without this, a genuinely harmless outcome while he's the
  // holder (a Pass that doesn't explode, or the new Keep-adjacent
  // pass-through cases) would silently overwrite an earlier, genuinely
  // valuable pending Rewind record with a no-op - confirmed reachable via
  // direct testing: Chronox takes a real hit from someone else, then later
  // the ball lands on him and he Passes it onward with zero effect on his
  // own hearts, and the earlier record was gone.
  if (preSnapshot && game.characters.chronox
    && chronoxStateActuallyChanged(game.characters.chronox, preSnapshot.chronoxSnapshot, null, null)) {
    game.characters.chronox.special.lastActionAgainstMe = preSnapshot;
  }
  // Not stamped with its own hearts - same reasoning as finalizeAction's
  // own deferred pushes above (this log array is local, followed by this
  // same call's own end-action a few lines down).
  if (result?.rebirthLogEntry) log.push(result.rebirthLogEntry);
  applyEndOfActionChecks(game);
  game.log.push(...log, { type: 'end-action', round: game.round, characterId: holderCharacterId, actionId: `jesterBall:${choice}`, hearts: heartsSnapshot(game) });
  return result;
}

// heartsSnapshot moved to damagePipeline.js (2026-08-30, imported above
// alongside applyDamage/etc.) so every ability file - which imports FROM
// damagePipeline.js, not the reverse - can call it directly to stamp its
// own standalone log.push() sites, without creating a circular import back
// into this file.

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
  game.chronoxLockoutTickedFor = new Set();
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
