import { applyDamage } from '../engine/damagePipeline.js';

export const actions = {
  mirageMark: {
    label: 'Mirage Mark',
    needsTarget: true,
    // Her only repeatable basic attack - deals no direct damage at all,
    // just plants/stacks the mark. Always legal, same as any basic attack.
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const marks = character.special.mirageMarks;
      const newCount = (marks.get(targetId) || 0) + 1;
      marks.set(targetId, newCount);
      log.push({ type: 'setup', characterId: character.id, actionId: 'mirageMark', targetId, stackCount: newCount });
      return {};
    },
  },
  mirageBurst: {
    label: 'Mirage Burst',
    needsTarget: true,
    // Fully repeatable, no cooldown, no usedSpecial gate - the only limit
    // is having any stacks to detonate at all. Legal per-target is
    // enforced via isValidTarget in turnEngine.js (needs a target with
    // 1+ stacks); this isLegal only gates whether the button/action shows
    // up AT ALL - true if ANY enemy currently has 1+ stacks, matching
    // Rowan's Arcane Study "hidden via isLegal alone" pattern (no separate
    // hidden field needed). hasAnyValidTarget (turnEngine.js) is what
    // actually filters this out of getUsableActions once no valid target
    // remains, same mechanism every other targeted action already uses.
    isLegal: (character) => {
      for (const count of character.special.mirageMarks.values()) {
        if (count > 0) return true;
      }
      return false;
    },
    execute(character, targetId, game, log) {
      const marks = character.special.mirageMarks;
      const stackCount = marks.get(targetId) || 0;
      marks.set(targetId, 0);
      // Confirmed ruling: bypasses EVERY dodge mechanic in the game
      // (Akyros, Marin, Grimtal, and her own passive too) - detonating an
      // already-planted mark isn't a fresh attack the target could evade.
      // Shield still absorbs it normally (not ignoresShield) - dodge-proof,
      // not shield-proof.
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: stackCount,
        ignoresDodge: true,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'mirageBurst', targetId, stackCount, ...result });
      return result;
    },
  },
};
