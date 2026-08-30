// Zero-import leaf module for the Rebirth category registry (see
// onOtherRevived.js for the companion cross-character cleanup hook, and the
// taxonomy in project memory: soulclash_mechanic_taxonomy.md #21).
// Re-exported through damagePipeline.js (registerRebirth) so ability files
// keep importing everything Rebirth-related from one place, matching how
// they already import applyDamage/applyHeal/etc. from there - this file
// itself has zero imports, same reasoning as dodgeDefenseRegistry.js (an
// ability file importing this indirectly through damagePipeline.js must
// never create a cycle back INTO an ability file).
const resetters = new Map();

export function registerRebirth(characterId, reset) {
  resetters.set(characterId, reset);
}

export function getRebirthResetter(characterId) {
  return resetters.get(characterId);
}
