// Generic dispatcher for the "Dodge Defense" category (see the taxonomy in
// project memory: soulclash_mechanic_taxonomy.md #4). Each dodge-capable
// character's own ability module registers a provider (canDodge/consume,
// plus an optional recordHit for Grimtal's every-hit bookkeeping) into
// dodgeDefenseRegistry.js at its own module-load time; this file is the
// single place that dispatches to whichever provider matches the current
// target, replacing what used to be N separate
// `if (target.id === '<name>' ...)` blocks inline in damagePipeline.js's
// applyDamage.
//
// Reads from dodgeDefenseRegistry.js (a zero-import leaf module) rather
// than importing the 4 ability files directly - damagePipeline.js has zero
// imports of its own by design (see its own top-of-file comment), and every
// ability file imports FROM damagePipeline.js, so importing an ability file
// (even indirectly through this dispatcher) would create a circular import.
// The registry is populated as a side effect of turnEngine.js's own static
// imports of all 16 ability modules at startup - by the time any real game
// logic runs, every provider is already registered.
import { getDodgeDefenseProvider } from './dodgeDefenseRegistry.js';

// Resolves whether `target` dodges a hit from `sourceCharacterId`. Mirrors
// the exact outer gate every one of the 4 original inline blocks shared
// (`!isMirror && !ignoresDodge && !isFrozen`), computed once here rather
// than re-derived per provider. Returns true (and has already mutated
// state/pushed the log entry) if the hit is dodged; false otherwise -
// callers should `return result` immediately on a true return, matching the
// original inline blocks' own early-return shape.
export function resolveDodgeDefense(game, log, target, sourceCharacterId, ctx) {
  const { isMirror, ignoresDodge, isFrozen } = ctx;
  const provider = getDodgeDefenseProvider(target.id);
  if (!provider) return false;
  if (isMirror || ignoresDodge || isFrozen) return false;
  const dodged = provider.canDodge(target, game, sourceCharacterId, ctx);
  // Grimtal's Grim Ward needs to record ANY attacker's hit this cycle -
  // dodged or not, run AFTER canDodge (matching the original inline block's
  // own has()-before-add ordering exactly: it checks membership, THEN
  // unconditionally adds on both the dodge and no-dodge paths). Every other
  // current provider has no equivalent need, so recordHit is optional.
  provider.recordHit?.(target, game, sourceCharacterId, log);
  if (!dodged) return false;
  provider.consume(target, game, sourceCharacterId, log);
  log.push({ type: 'dodge', attackerId: sourceCharacterId, targetCharacterId: target.id });
  return true;
}
