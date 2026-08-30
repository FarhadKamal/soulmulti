// Generic dispatcher for KO-branch cleanup - NOT one of the 29 taxonomy
// categories itself, but a lifecycle hook (mirrors turnEngine.js's already-
// generic onTurnStart dispatch pattern) that several categories' cleanup
// logic hangs off of. Each ability module MAY register an onOwnDeath
// callback (character, game, log) => void|object, called exactly once,
// right when `target.isKO` first flips true inside applyDamage's KO branch
// - this replaces what used to be a flat sequence of
// `if (target.id === '<name>') { ...cleanup... }` blocks there.
//
// A callback MAY return a plain object of data that needs to survive PAST
// the KO branch, into the rest of that same applyDamage call (e.g. Athena's
// curse-clear returning { preClearCursedId } so her later curse-mirror
// check - registered as a late onHitLanded callback, see onHitLanded.js -
// can still see who was cursed even though this callback already cleared
// it). damagePipeline.js merges this into the shared `ctx` object it
// threads through the rest of the call - same return-value contract as
// onHitLanded.js/onHitLandedEarly.js, kept consistent across all 3 hooks.
//
// Registered the same way as Dodge Defense (see dodgeDefenseRegistry.js) -
// a zero-import Map, populated by each ability module calling
// registerOnOwnDeath(characterId, callback) at its own module-load time -
// to avoid the same circular-import problem (damagePipeline.js cannot
// import an ability file directly, since every ability file imports FROM
// damagePipeline.js).
const callbacks = new Map();

export function registerOnOwnDeath(characterId, callback) {
  callbacks.set(characterId, callback);
}

export function runOnOwnDeath(character, game, log) {
  const callback = callbacks.get(character.id);
  return callback ? callback(character, game, log) : undefined;
}
