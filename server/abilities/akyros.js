import { applyDamage, tryTriggerCleanSlate } from '../engine/damagePipeline.js';

function anyEnemyIsMarked(game, akyrosId) {
  const akyros = game.characters[akyrosId];
  return Object.values(game.characters).some(
    (c) => c.ownerId !== akyros.ownerId && !c.isKO && akyros.special.marks.has(c.id)
  );
}

export const actions = {
  hiddenMark: {
    label: 'Hidden Mark',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the mark itself - deliberately
      // does NOT add to everMarkedIds, since the mark never actually took;
      // "once marked, never again" shouldn't apply to an attempt that was
      // cleansed before it landed.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'hidden-mark', characterId: character.id, targetId, hidden: true, blocked: true });
        return {};
      }
      character.special.marks.add(targetId);
      // Once marked, a target can never be marked again for the rest of the
      // match - even after the mark is revealed/consumed by Fatal Slash or
      // Shadow Execution.
      character.special.everMarkedIds.add(targetId);
      // Deliberately no public log text naming the target; UI shows a
      // generic "Hidden Mark placed" line so other players can't see it.
      log.push({ type: 'hidden-mark', characterId: character.id, targetId, hidden: true });
      return {};
    },
  },
  fatalSlash: {
    label: 'Fatal Slash',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const wasMarked = character.special.marks.has(targetId);
      if (wasMarked) character.special.revealedMarks.add(targetId);
      const amount = wasMarked ? 2 : 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'fatalSlash', targetId, wasMarked, ...result });
      return result;
    },
  },
  shadowExecution: {
    label: 'Shadow Execution',
    needsTarget: true,
    special: true,
    isLegal: (character, game) => !character.usedSpecial && anyEnemyIsMarked(game, character.id),
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      // Shadow Execution can only ever target an already-marked enemy (see
      // isLegal/isValidTarget), and using it is a public, logged action - so
      // it reveals that mark just like Fatal Slash does.
      character.special.revealedMarks.add(targetId);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 3,
        ignoresShield: true,
      });
      log.push({ type: 'special', characterId: character.id, actionId: 'shadowExecution', targetId, ...result });
      return result;
    },
  },
};

export function legalShadowExecutionTargets(character, game) {
  return Object.values(game.characters).filter(
    (c) => c.ownerId !== character.ownerId && !c.isKO && character.special.marks.has(c.id)
  );
}
