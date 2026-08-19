import { applyDamage, applyHeal } from '../engine/damagePipeline.js';

// The full discoverable spell pool - Arcane Study draws one of whichever
// aren't in special.discoveredSpells yet, so each ever appears at most once
// per match.
const ALL_SPELL_IDS = ['poisonCloud', 'purify', 'wildLightning', 'mirrorReflect', 'silenceLock'];

function pickUndiscoveredSpell(character) {
  const remaining = ALL_SPELL_IDS.filter((id) => !character.special.discoveredSpells.has(id));
  if (remaining.length === 0) return null;
  return remaining[Math.floor(Math.random() * remaining.length)];
}

// Fires once at the start of Rowan's own turn (turnEngine.js's
// beginCharacterTurn, gated by game.turnStartFiredFor). Resolves the
// one-turn-delayed Arcane Study reveal, clears its cooldown, and ends any
// still-active Mirror Reflect window - all three are "active until my own
// next turn starts" effects, same shape as Draxus's deathproofActive.
export function onTurnStart(character, game, log) {
  if (character.special.arcaneStudyPending) {
    const spellId = pickUndiscoveredSpell(character);
    character.special.arcaneStudyPending = false;
    if (spellId) {
      character.special.discoveredSpells.add(spellId);
      log.push({ type: 'spell-discovered', characterId: character.id, spellId });
    }
  }
  if (character.special.arcaneStudyOnCooldown) {
    character.special.arcaneStudyOnCooldown = false;
  }
  if (character.special.mirrorReflectActive) {
    character.special.mirrorReflectActive = false;
  }
}

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
  arcaneStudy: {
    label: 'Arcane Study',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.special.arcaneStudyOnCooldown
      && character.special.discoveredSpells.size < ALL_SPELL_IDS.length,
    execute(character, targetId, game, log) {
      character.special.arcaneStudyPending = true;
      character.special.arcaneStudyOnCooldown = true;
      log.push({ type: 'setup', characterId: character.id, actionId: 'arcaneStudy' });
      return {};
    },
  },
  poisonCloud: {
    label: 'Poison Cloud',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.special.discoveredSpells.has('poisonCloud')
      && !character.special.usedSpells.has('poisonCloud'),
    execute(character, targetId, game, log) {
      character.special.usedSpells.add('poisonCloud');
      character.special.poisonTargets.add(targetId);
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
        if (c.special?.marks?.has(character.id)) c.special.marks.delete(character.id);
        if (c.special?.revealedMarks?.has(character.id)) c.special.revealedMarks.delete(character.id);
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
      character.special.silenceTargets.set(targetId, 2);
      // Also strips any shield the target already has, on top of blocking
      // every shield source (passive resets like Chrono Guard, and any
      // active shield-granting move) for the whole silence duration - see
      // isSilenced's call sites in damagePipeline.js/chronox.js.
      const target = game.characters[targetId];
      if (target) target.shield = 0;
      log.push({ type: 'special', characterId: character.id, actionId: 'silenceLock', targetId });
      return {};
    },
  },
};
