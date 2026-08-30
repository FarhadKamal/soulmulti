// Zero-import leaf module for the Dodge Defense category registry (see
// dodgeDefense.js for the dispatcher that reads it, and the taxonomy in
// project memory: soulclash_mechanic_taxonomy.md #4).
//
// damagePipeline.js is deliberately import-free by design (see its own
// top-of-file comment) - every one of the 16 ability files imports FROM it,
// so it importing back from any ability file (even indirectly through a
// dispatcher) would create a circular import. This file breaks that cycle:
// each dodge-capable ability module calls registerDodgeDefense(characterId,
// provider) once at its own module-load time (a plain top-level call, not
// an export consumed by anyone else), and damagePipeline.js's dispatcher
// only ever reads FROM this registry - never imports an ability file
// directly.
const providers = new Map();

export function registerDodgeDefense(characterId, provider) {
  providers.set(characterId, provider);
}

export function getDodgeDefenseProvider(characterId) {
  return providers.get(characterId);
}
