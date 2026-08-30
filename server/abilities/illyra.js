import { applyDamage } from '../engine/damagePipeline.js';
import { registerDodgeDefense } from '../engine/categories/dodgeDefenseRegistry.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';

// Mirage Burst's per-target damage: each stack is worth 1.5 damage,
// rounded down - confirmed ruling, matches the exact sequence given
// (1 stack->1, 2->3, 3->4, 4->6, 5->7, continuing 6->9, 7->10...). Not a
// flat 1-per-stack any more.
function burstDamageFor(stackCount) {
  return Math.floor(stackCount * 1.5);
}

// Total mirage stack-points Mirage Overload throws, keyed by how many
// characters (including her) are currently alive - confirmed ruling: 7 at
// 4 alive, 5 at 3 alive, 2 at 2 alive (a 1v1 is explicitly allowed, no
// headcount gate on casting it at all - only her own hearts <= 3 gates
// legality, see isLegal below).
const OVERLOAD_STACKS_BY_ALIVE_COUNT = { 4: 7, 3: 5, 2: 2 };

// Dodge Defense category registration (see
// engine/categories/dodgeDefense.js) - additive, not yet consumed by
// applyDamage's own inline dodge block. A flat, unconditional 50% chance on
// every hit - memoryless, no per-attacker or charge-pool tracking. Also
// excludes poison ticks (ctx.isPoisonTick) - an already-applied DoT isn't
// something her illusion can retroactively avoid.
registerDodgeDefense('illyra', {
  canDodge(target, game, sourceCharacterId, ctx) {
    return !ctx.isPoisonTick && Math.random() < 0.5;
  },
  consume() {},
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - her Mirage
// Mark stacks don't survive a target's own revival either, same "comes
// back fresh" reasoning as every other stale-reference cleanup - otherwise
// a banked stack from before they died would still be sitting there ready
// to detonate on their reborn self, even though they never should have
// carried it over.
registerOnOtherRevived((revivedCharacterId, game) => {
  const illyra = game.characters.illyra;
  if (illyra) illyra.special.mirageMarks.delete(revivedCharacterId);
});

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
        // evade. Also bypasses untargetable (e.g. Velorya's Lunar
        // Eclipse) for the exact same reasoning - the mark was already
        // planted before she went untargetable, so a later Eclipse
        // shouldn't retroactively nullify the detonation. Confirmed real
        // gap: without ignoresUntargetable, applyDamage's own defensive
        // untargetable re-check (damagePipeline.js) silently no-op'd the
        // whole hit at 0 damage, even though the mark stack was genuinely
        // there. Shield still absorbs it normally (not ignoresShield) -
        // dodge-proof and untargetable-proof, not shield-proof.
        const result = applyDamage(game, log, {
          sourceCharacterId: character.id,
          targetCharacterId: tid,
          amount: burstDamageFor(stackCount),
          ignoresDodge: true,
          ignoresUntargetable: true,
        });
        bursts.push({ targetId: tid, stackCount, ...result });
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'mirageBurst', bursts });
      return { bursts };
    },
  },
  // Mirage Overload: her desperate last-stand special. No-target, one-time
  // use, only legal once she's genuinely on the brink (hearts <= 3,
  // confirmed ruling) - no headcount gate on casting it at all, usable at
  // any alive-count including a straight 1v1 (only the total stack-point
  // pool scales down with fewer targets - see OVERLOAD_STACKS_BY_ALIVE_COUNT
  // above). Deals ZERO direct damage on its own (confirmed ruling) - it
  // ONLY plants mirage stacks, exactly like Mirage Mark does, just
  // scattered across everyone at once instead of one chosen target. She'd
  // still need to cast Mirage Burst separately afterward to cash any of
  // them in for damage.
  mirageOverload: {
    label: 'Mirage Overload',
    needsTarget: false,
    special: true,
    isLegal: (character, game) => {
      if (character.special.mirageOverloadUsed) return false;
      return character.hearts <= 3;
    },
    execute(character, targetId, game, log) {
      character.special.mirageOverloadUsed = true;
      const others = Object.values(game.characters).filter((c) => c.id !== character.id && !c.isKO);
      const aliveCount = others.length + 1; // +1 for herself
      const totalStacks = OVERLOAD_STACKS_BY_ALIVE_COUNT[aliveCount] ?? 0;
      const marks = character.special.mirageMarks;
      // Fully independent random assignment, EACH of the totalStacks
      // points separately - deliberately NOT an even/balanced split
      // (confirmed ruling: "totally random... someone can get 7 mirage!").
      // No weighting, no minimum-per-target guarantee, no cap - a genuine
      // coin-flip-per-point, so a lopsided or even a single-target result
      // is completely normal, not a bug.
      const landedOn = {};
      for (let i = 0; i < totalStacks; i++) {
        if (others.length === 0) break; // defensive - can't happen once alive-count table is respected, but never divide by zero
        const target = others[Math.floor(Math.random() * others.length)];
        const newCount = (marks.get(target.id) || 0) + 1;
        marks.set(target.id, newCount);
        landedOn[target.id] = (landedOn[target.id] || 0) + 1;
      }
      log.push({
        type: 'special', characterId: character.id, actionId: 'mirageOverload',
        totalStacks, landedOn,
      });
      return { landedOn };
    },
  },
};
