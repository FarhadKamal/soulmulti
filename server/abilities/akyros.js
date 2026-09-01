import { applyDamage, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { registerDodgeDefense } from '../engine/categories/dodgeDefenseRegistry.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';

function anyEnemyIsMarked(game, akyrosId) {
  const akyros = game.characters[akyrosId];
  return Object.values(game.characters).some(
    (c) => c.ownerId !== akyros.ownerId && !c.isKO && akyros.special.marks.has(c.id)
  );
}

// Dodge Defense category registration (see
// engine/categories/dodgeDefense.js) - additive, not yet consumed by
// applyDamage's own inline dodge block. Per-attacker, one-time: dodges each
// unique attacker once, tracked in dodgedAttackerIds, no recharge.
registerDodgeDefense('akyros', {
  canDodge(target, game, sourceCharacterId) {
    return !target.special.dodgedAttackerIds.has(sourceCharacterId);
  },
  consume(target, game, sourceCharacterId) {
    target.special.dodgedAttackerIds.add(sourceCharacterId);
  },
});

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - marks (hidden
// and revealed) die with him, no point keeping track once he can never use
// Fatal Slash/Shadow Execution again.
registerOnOwnDeath('akyros', (character) => {
  character.special.marks.clear();
  character.special.revealedMarks.clear();
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - his current
// Hidden Mark on a now-revived character doesn't survive their death
// either - they're coming back fresh, so Fatal Slash/Shadow Execution
// shouldn't still get the marked bonus against them. Only the CURRENT mark
// is cleared (marks/revealedMarks) - everMarkedIds is left alone, so he
// still can't place a brand-new mark on them later (same "once marked,
// never again" rule as everyone else).
registerOnOtherRevived((revivedCharacterId, game) => {
  const akyros = game.characters.akyros;
  if (!akyros) return;
  akyros.special.marks.delete(revivedCharacterId);
  akyros.special.revealedMarks.delete(revivedCharacterId);
});

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
      // cleansed before it landed. blockedBy names WHICH mechanic actually
      // fired (confirmed bug, 2026-09-01 - see chronox.js's identical
      // fix/comment on Time Freeze for the full reasoning). Also fixes a
      // second gap on this specific ability: the client never displayed
      // `blocked` for hidden-mark entries at all, so a blocked mark
      // attempt used to silently read as a successful one in the log -
      // see battleScreen.js's describeLogEntry for the matching client fix.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'hidden-mark', characterId: character.id, targetId, hidden: true, blockedBy: 'cleanSlate' });
        return {};
      }
      // Illyra's passive: a 50% chance the mark itself simply doesn't
      // take - same "never added to everMarkedIds" reasoning as the Clean
      // Slate case just above, an attempt that never actually lands
      // shouldn't burn her "once ever" mark eligibility.
      if (tryIllyraDodgeStatus(target, game, log, character.id)) {
        log.push({ type: 'hidden-mark', characterId: character.id, targetId, hidden: true, blockedBy: 'illyra' });
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
