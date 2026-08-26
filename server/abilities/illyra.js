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
    // No-target: one click detonates EVERY currently-marked enemy at once
    // (confirmed ruling), not a single chosen target - each takes damage
    // equal to their OWN stack count, independently. Fully repeatable, no
    // cooldown, no usedSpecial gate - the only limit is having any stacks
    // to detonate at all.
    needsTarget: false,
    isLegal: (character) => {
      for (const count of character.special.mirageMarks.values()) {
        if (count > 0) return true;
      }
      return false;
    },
    execute(character, targetId, game, log) {
      const marks = character.special.mirageMarks;
      const bursts = [];
      // Snapshot the target list BEFORE clearing anything - iterating and
      // mutating the same Map in one pass is fine here since .set() never
      // adds new keys mid-loop (only zeroes existing ones), but snapshotting
      // makes the intent explicit and survives any future refactor safely.
      for (const [tid, stackCount] of [...marks.entries()]) {
        if (stackCount <= 0) continue;
        marks.set(tid, 0);
        // Confirmed ruling: bypasses EVERY dodge mechanic in the game
        // (Akyros, Marin, Grimtal, and her own passive too) - detonating an
        // already-planted mark isn't a fresh attack the target could
        // evade. Shield still absorbs it normally (not ignoresShield) -
        // dodge-proof, not shield-proof.
        const result = applyDamage(game, log, {
          sourceCharacterId: character.id,
          targetCharacterId: tid,
          amount: stackCount,
          ignoresDodge: true,
        });
        bursts.push({ targetId: tid, stackCount, ...result });
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'mirageBurst', bursts });
      return { bursts };
    },
  },
};
