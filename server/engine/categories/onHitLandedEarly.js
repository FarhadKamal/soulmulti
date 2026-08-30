// Generic dispatcher for "a hit just reduced my hearts" reactions that must
// run BEFORE the KO/Rebirth branch, since they need to see hearts exactly
// as reduced by shield absorption above - not yet affected by any KO flag
// flip or revival. Two current registrants: Rowan's Mirror Reflect (its
// "did he survive" check reads character.hearts > 0 directly, and must do
// so before Rebirth/Draxus-deathproof logic could otherwise run first) and
// Chronox's Rewind drift-correction (needs ctx.heartsBefore, captured at
// this exact point, to compute how much unrelated damage just landed). A
// DIFFERENT, later dispatch point (onHitLanded.js/runOnHitLanded) exists
// for reactions that don't need this early timing (Melyssa's reactive
// shield, Kaelis's grudge, Athena's curse-mirror) - deliberately kept as
// two separate named registries rather than one shared one, so a future
// character registering here can't accidentally run at the wrong point in
// applyDamage just because another character's callback happens to be
// registered under the same map. Since dispatch is keyed by `target.id`,
// at most ONE callback ever fires per applyDamage call regardless of how
// many characters are registered - no collision risk between registrants.
//
// Same return-value contract as onHitLanded.js: a callback may return a
// plain object of extra fields to merge onto the caller's own `result`.
const callbacks = new Map();

export function registerOnHitLandedEarly(characterId, callback) {
  callbacks.set(characterId, callback);
}

export function runOnHitLandedEarly(target, game, log, ctx) {
  const callback = callbacks.get(target.id);
  return callback ? callback(target, game, log, ctx) : undefined;
}
