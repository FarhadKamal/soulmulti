import { applyDamage, applyHeal, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnHitLandedEarly } from '../engine/categories/onHitLandedEarly.js';
import { makeDiscoveryKit } from '../engine/categories/discoveryKit.js';

// Mirror Reflect counter (see engine/categories/onHitLanded.js): any direct
// (non-mirrored) hit that lands real damage on him while it's active, and
// that he SURVIVES (post-damage hearts > 0), automatically deals 3 damage
// back to the attacker - on top of Rowan still taking the original hit
// normally (this doesn't block/reduce anything). Modeled directly on
// Athena's own curse-mirror: a nested applyDamage call with isMirror: true,
// which both prevents Akyros's Dodge from applying to the reflected hit and
// prevents infinite mirror recursion. Confirmed ruling: stays active
// indefinitely across any number of Rowan's own turns - it does NOT
// auto-clear at his next turn start, only ending once it actually fires,
// right here. Returns { mirrorReflectResult, mirrorReflectLogEntry } for
// the dispatcher to merge onto applyDamage's own result object.
registerOnHitLandedEarly('rowan', (character, game, log, ctx) => {
  if (!character.special.mirrorReflectActive) return;
  if (ctx.isMirror || ctx.amountDealt <= 0 || character.hearts <= 0 || ctx.sourceCharacterId === character.id) return;
  // Kaelis's Ashka's Vengeance - confirmed ruling, 2026-09-07: "kaleis
  // will not suffer what ashka did" - her phoenix's own independent bonus
  // strike must never trigger a reflect back onto her, since she didn't
  // personally make this attack.
  if (ctx.isAshkaStrike) return;
  // Boingo's Fowl Play - confirmed ruling: "no defense of any kind"
  // extends to Counter Attack too, even though it's a retaliation rather
  // than something that PREVENTS him taking damage - a chickenified Rowan
  // who still has Mirror Reflect armed from before the transformation
  // (in-progress state is preserved, not reset - see turnEngine.js) must
  // not have it fire while he's a chicken. It stays armed and available
  // again once he reverts, rather than being consumed/wasted here.
  if (character.isChicken) return;
  character.special.mirrorReflectActive = false;
  const mirrorReflectResult = applyDamage(game, log, {
    sourceCharacterId: character.id,
    targetCharacterId: ctx.sourceCharacterId,
    amount: 3,
    isMirror: true,
  });
  return {
    mirrorReflectResult,
    mirrorReflectLogEntry: {
      type: 'mirror-reflect',
      fromCharacterId: character.id,
      toCharacterId: ctx.sourceCharacterId,
      amount: 3,
      koTriggered: mirrorReflectResult.koTriggered,
      revived: mirrorReflectResult.revived,
    },
  };
});

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - his own death
// ends every effect HE cast on anyone else immediately: Poison Cloud stops
// ticking, Silence Lock's remaining turns are cleared (targets freed), and
// a still-pending Mirror Reflect window is cancelled. Does not undo damage
// already dealt by past ticks/reflects, only stops future ones (confirmed
// explicit design rule).
registerOnOwnDeath('rowan', (character) => {
  character.special.poisonTargets.clear();
  character.special.silenceTargets.clear();
  character.special.mirrorReflectActive = false;
  // Safety net: if he somehow dies before his own Petrify follow-up action
  // ever resolves (e.g. a poison tick or Prophecy of Doom fires between the
  // cast and his next turn), the stone visual shouldn't get stuck forever
  // with no one left to clear it.
  character.special.petrifyPending = false;
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - his Poison
// Cloud doesn't survive a target's own revival either, same "comes back
// fresh" reasoning - otherwise the very next poison tick on their own turn
// would immediately start killing them again with no way to ever escape it.
registerOnOtherRevived((revivedCharacterId, game) => {
  const rowan = game.characters.rowan;
  if (rowan) rowan.special.poisonTargets.delete(revivedCharacterId);
});

// NOTE: worldStops-aware cleanse lives directly in this file's purify
// action below (removes Rowan alone from a shared frozen group, same
// partial-cleanse reasoning as damagePipeline.js's own
// clearNegativeStatuses for World Stops) rather than importing
// isFrozenByChronox, since the existing per-status loop here already
// mutates `c.special` fields directly one at a time.

// The full discoverable spell pool - Arcane Study draws one of whichever
// aren't in special.discoveredSpells yet, so each ever appears at most once
// per match. Rowan's onDiscover is a no-op (unlike Marin's) - none of his
// 5 spells auto-activate; each becomes a separate manually-cast action,
// gated by discoveredSpells.has(id) && !usedSpells.has(id) below.
const ALL_SPELL_IDS = ['poisonCloud', 'purify', 'wildLightning', 'mirrorReflect', 'silenceLock'];
const discoveryKit = makeDiscoveryKit({ spellIds: ALL_SPELL_IDS });

// Fires once at the start of Rowan's own turn (turnEngine.js's
// beginCharacterTurn, gated by game.turnStartFiredFor). Resolves the
// one-turn-delayed Arcane Study reveal and clears its cooldown - both are
// "active until my own next turn starts" effects, same shape as Draxus's
// deathproofActive. Mirror Reflect is NOT cleared here - confirmed ruling:
// it stays active indefinitely across any number of Rowan's own turns,
// only ending once it actually lands a reflect off an incoming hit (see
// damagePipeline.js's mirror-trigger block, which clears the flag itself
// right after firing).
export function onTurnStart(character, game, log) {
  discoveryKit.resolveOnTurnStart(character, game, log);
}

// Petrify (hearts<=3 one-time bonus action, working name, design-locked
// 2026-09-09 - see project memory soulclash_rowan_petrify.md): combines
// existing Neutral Action (#25) - same discovery mechanism Arcane Study
// itself already uses, just an instant batch reveal instead of the normal
// one-turn-delayed single pick - with the Bonus action-type label
// (confirmed ruling: "that was bonus turn for him.. after that he can use
// any action he want" - does NOT consume his turn, unlike a normal Arcane
// Study cast). Legal only while at least one of his 5 spells is still
// undiscovered - if he already knows all 5 by the time he crosses the
// threshold, this is simply never offered.
const PETRIFY_HEARTS_THRESHOLD = 3;

export const actions = {
  wandStrike: {
    label: 'Wand Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const result = applyDamage(game, log, { sourceCharacterId: character.id, targetCharacterId: targetId, amount: 1 });
      log.push({ type: 'attack', characterId: character.id, actionId: 'wandStrike', targetId, ...result });
      return result;
    },
  },
  arcaneStudy: discoveryKit.arcaneStudy,
  poisonCloud: {
    label: 'Poison Cloud',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.special.discoveredSpells.has('poisonCloud')
      && !character.special.usedSpells.has('poisonCloud'),
    execute(character, targetId, game, log) {
      character.special.usedSpells.add('poisonCloud');
      // Marin's Clean Slate deliberately does NOT cover Poison Cloud -
      // confirmed scope change: she's still vulnerable to it, same as
      // anyone else. (Clean Slate still covers Curse Strike, Time Freeze,
      // Hidden Mark, and Silence Lock - see hasNegativeStatus/
      // tryTriggerCleanSlate in damagePipeline.js.)
      character.special.poisonTargets.add(targetId);
      // Poison Cloud deals no direct damage on cast (applyDamage is never
      // called here), so Kaelis's grudge counter - which normally increments
      // inside applyDamage whenever a real hit lands on her - would never
      // register this as an attack at all. The cast itself IS the one
      // attack that should count (the recurring ticks afterward are
      // deliberately excluded via applyDamage's isPoisonTick flag), so
      // increment it here to match "one cast = one grudge point."
      if (targetId === 'kaelis') {
        const target = game.characters[targetId];
        const counts = target.special.grudgeCounts;
        counts.set(character.id, (counts.get(character.id) || 0) + 1);
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'poisonCloud', targetId });
      return {};
    },
  },
  purify: {
    label: 'Purify',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.special.discoveredSpells.has('purify')
      && !character.special.usedSpells.has('purify'),
    execute(character, targetId, game, log) {
      character.special.usedSpells.add('purify');
      // Clears every negative status any OTHER character has placed on
      // Rowan - scanned generically rather than a hardcoded per-character
      // list, so this stays correct if a future character adds a new kind
      // of negative status without needing changes here.
      for (const c of Object.values(game.characters)) {
        if (c.special?.curseTargetCharacterId === character.id) c.special.curseTargetCharacterId = null;
        if (c.special?.freezeActive && c.special.freezeTargetId === character.id) {
          c.special.freezeActive = false;
          c.special.freezeTargetId = null;
        }
        // World Stops equivalent - removes Rowan alone from a shared
        // frozen group without ending it for anyone else still frozen
        // (confirmed audit gap: this loop previously had zero awareness of
        // World Stops at all).
        if (c.special?.worldStopsActive && c.special.worldStopsFrozenIds?.has(character.id)) {
          c.special.worldStopsFrozenIds.delete(character.id);
          if (c.special.worldStopsFrozenIds.size === 0) c.special.worldStopsActive = false;
        }
        if (c.special?.marks?.has(character.id)) c.special.marks.delete(character.id);
        if (c.special?.revealedMarks?.has(character.id)) c.special.revealedMarks.delete(character.id);
        // Confirmed ruling: grudge accumulated against Rowan counts as a
        // status he can cleanse on himself via Purify, same as every other
        // negative status here - clears whatever hit-count Kaelis has
        // tallied against him back to 0.
        if (c.special?.grudgeCounts?.has(character.id)) c.special.grudgeCounts.delete(character.id);
        if (c.special?.poisonTargets?.has(character.id)) c.special.poisonTargets.delete(character.id);
        if (c.special?.silenceTargets?.has(character.id)) c.special.silenceTargets.delete(character.id);
        if (c.special?.streakTargetId === character.id) {
          c.special.streakTargetId = null;
          c.special.streakCount = 0;
        }
      }
      character.skipNextTurn = false;
      const healed = applyHeal(game, character.id, character.maxHearts);
      log.push({ type: 'special', characterId: character.id, actionId: 'purify', healed });
      return { healed };
    },
  },
  wildLightning: {
    label: 'Wild Lightning',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.special.discoveredSpells.has('wildLightning')
      && !character.special.usedSpells.has('wildLightning'),
    execute(character, targetId, game, log) {
      character.special.usedSpells.add('wildLightning');
      const amount = 1 + Math.floor(Math.random() * 7); // 1-7 inclusive
      const result = applyDamage(game, log, { sourceCharacterId: character.id, targetCharacterId: targetId, amount });
      log.push({ type: 'special', characterId: character.id, actionId: 'wildLightning', targetId, ...result });
      return result;
    },
  },
  mirrorReflect: {
    label: 'Mirror Reflect',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.special.discoveredSpells.has('mirrorReflect')
      && !character.special.usedSpells.has('mirrorReflect'),
    execute(character, targetId, game, log) {
      character.special.usedSpells.add('mirrorReflect');
      character.special.mirrorReflectActive = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'mirrorReflect' });
      return {};
    },
  },
  silenceLock: {
    label: 'Silence Lock',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.special.discoveredSpells.has('silenceLock')
      && !character.special.usedSpells.has('silenceLock'),
    execute(character, targetId, game, log) {
      character.special.usedSpells.add('silenceLock');
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the silence itself - the cast
      // still spends Rowan's one-time use of this spell, it just never
      // actually locks her special ability away. blockedBy names WHICH
      // mechanic actually fired (confirmed bug, 2026-09-01 - see
      // chronox.js's identical fix/comment on Time Freeze for the full
      // reasoning: this used to be an ambiguous blocked: true regardless
      // of which check below succeeded).
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'silenceLock', targetId, blockedBy: 'cleanSlate' });
        return {};
      }
      // Illyra's passive: a 50% chance the silence itself simply doesn't
      // take - the cast still spends this one-time spell either way, same
      // reasoning as the Clean Slate case above.
      if (tryIllyraDodgeStatus(target, game, log, character.id)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'silenceLock', targetId, blockedBy: 'illyra' });
        return {};
      }
      character.special.silenceTargets.set(targetId, 3);
      // Also strips any shield the target already has, on top of blocking
      // every shield source (passive resets like Chrono Guard, and any
      // active shield-granting move) for the whole silence duration - see
      // isSilenced's call sites in damagePipeline.js/chronox.js.
      if (target) target.shield = 0;
      log.push({ type: 'special', characterId: character.id, actionId: 'silenceLock', targetId });
      return {};
    },
  },
  petrify: {
    label: 'Petrify',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= PETRIFY_HEARTS_THRESHOLD
      && !character.special.usedPetrify
      && character.special.discoveredSpells.size < ALL_SPELL_IDS.length,
    execute(character, targetId, game, log) {
      character.special.usedPetrify = true;
      // Real serialized state (not a client-inferred flag) - true from the
      // instant this cast resolves until his own real follow-up action
      // clears it (index.js's own action handlers do this explicitly, same
      // "held until it's genuinely over" pattern as deathproofActive/
      // controlling). The client's "everyone else shows stone.jpg" check
      // reads THIS field directly off the broadcast game state, the same
      // way Fowl Play's isChicken/Melyssa's controlling/Draxus's
      // deathproofActive already work - confirmed live bug, 2026-09-10: an
      // earlier version tracked this as purely client-local module state
      // (set/cleared by watching log-entry sequence), which had no source
      // of truth to fall back on and silently never displayed correctly
      // for at least one real player, root cause never fully isolated.
      // Real broadcast state can't drift from what the server actually
      // knows the way inferred client state can.
      character.special.petrifyPending = true;
      // Instantly discovers every remaining spell in one shot - bypasses
      // discoveryKit's own one-turn-delayed arcaneStudyPending mechanism
      // entirely (that's Arcane Study's normal pace, this is the "finish
      // it all right now" desperation version). Each newly-discovered
      // spell gets its own log entry, same shape/type as Arcane Study's
      // normal single reveal, so the client's existing 'spell-discovered'
      // handling (log text, sound, voice) needs no special-casing for
      // multiple entries landing in the same batch.
      const newlyDiscovered = [];
      for (const spellId of ALL_SPELL_IDS) {
        if (!character.special.discoveredSpells.has(spellId)) {
          character.special.discoveredSpells.add(spellId);
          newlyDiscovered.push(spellId);
        }
      }
      for (const spellId of newlyDiscovered) {
        log.push({ type: 'spell-discovered', characterId: character.id, spellId });
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'petrify', discoveredSpellIds: newlyDiscovered });
      // Genuine Bonus action (see index.js's own handling, mirroring
      // Draxus's Deathless Fury bonus-strike pattern) - does NOT consume
      // his turn. The caller checks actionId === 'petrify' and skips
      // markCharacterActed, so he still gets to choose a real action
      // immediately afterward in this same turn, fully unrestricted
      // (confirmed ruling: "he can use any action he want... not
      // restricted purify or mirror").
      return { isBonusAction: true };
    },
  },
};
