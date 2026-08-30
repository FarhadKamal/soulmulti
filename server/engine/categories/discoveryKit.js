// Factory for the "Discovery/Unlock" category (a Neutral Action variant,
// see the taxonomy in project memory: soulclash_mechanic_taxonomy.md #25) -
// Arcane Study's shared mechanism: a fixed spell pool, one random
// undiscovered pick revealed on the caster's own next turn after casting,
// each spell appearing at most once per match. Rowan and Marin both use
// this exact mechanism with different pools; they diverge only in what
// happens AT the moment of discovery (Rowan: nothing, the spell just
// becomes a normal manually-cast action gated by discoveredSpells.has(id);
// Marin: an onDiscover hook immediately flips a passive-active flag, since
// none of her 5 "spells" have their own separate castable action at all).
//
// Like neutralAction.js's makeSetupAction, this is action-DEFINITION
// duplication, not applyDamage-dispatch duplication - the factory's output
// (arcaneStudy action def + a resolveOnTurnStart function) is consumed
// exactly the way any other action/onTurnStart logic already is, no new
// dispatcher/registry needed.
export function makeDiscoveryKit({ spellIds, onDiscover }) {
  function pickUndiscoveredSpell(character) {
    const remaining = spellIds.filter((id) => !character.special.discoveredSpells.has(id));
    if (remaining.length === 0) return null;
    return remaining[Math.floor(Math.random() * remaining.length)];
  }

  const arcaneStudy = {
    label: 'Arcane Study',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.special.arcaneStudyOnCooldown
      && character.special.discoveredSpells.size < spellIds.length,
    execute(character, targetId, game, log) {
      character.special.arcaneStudyPending = true;
      character.special.arcaneStudyOnCooldown = true;
      log.push({ type: 'setup', characterId: character.id, actionId: 'arcaneStudy' });
      return {};
    },
  };

  // Resolves the one-turn-delayed reveal and clears the cooldown - both are
  // "active until my own next turn starts" effects. Callers with their own
  // additional onTurnStart work (Marin's Everbloom tick, Clean Slate
  // countdown) should call this FIRST, then continue with the rest of
  // their own onTurnStart body, matching the exact ordering both files
  // already used before this factory existed. Returns whatever onDiscover
  // itself returns (or undefined if no spell was discovered this call, or
  // no onDiscover was supplied) - lets a caller like Marin's onTurnStart
  // learn "did discovery-time cleanup just do something this SAME call"
  // (e.g. Clean Slate's immunity-just-started guard) without needing a
  // persisted field on character.special, keeping that as a genuine local
  // variable exactly like the original hand-written implementation had.
  function resolveOnTurnStart(character, game, log) {
    let onDiscoverResult;
    if (character.special.arcaneStudyPending) {
      const spellId = pickUndiscoveredSpell(character);
      character.special.arcaneStudyPending = false;
      if (spellId) {
        character.special.discoveredSpells.add(spellId);
        log.push({ type: 'spell-discovered', characterId: character.id, spellId });
        onDiscoverResult = onDiscover?.(character, game, log, spellId);
      }
    }
    if (character.special.arcaneStudyOnCooldown) {
      character.special.arcaneStudyOnCooldown = false;
    }
    return onDiscoverResult;
  }

  return { arcaneStudy, pickUndiscoveredSpell, resolveOnTurnStart };
}
