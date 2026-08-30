// Generic dispatcher for "a real (non-mirrored, non-poison-tick) hit
// landed on me" reactions - NOT one of the 29 taxonomy categories itself,
// but a lifecycle hook several categories' passive/reactive logic hangs off
// of (Grudge #28's accumulation side, Shield Defense #5's reactive-shield
// variant). Each ability module MAY register a callback (target, game, log,
// ctx) => void, dispatched once per applyDamage call, right after damage
// has been applied to target.hearts - replaces what used to be
// `if (target.id === '<name>') { ... }` blocks in that spot.
//
// A callback MAY return a plain object of extra fields to merge onto the
// caller's own `result`. This dispatch point is gated on `!target.isKO` by
// its caller - use onHitLandedEarly.js instead for a reaction that must run
// BEFORE the KO/Rebirth branch (e.g. Rowan's Mirror Reflect, which checks
// character.hearts > 0 directly and must do so before any revival logic
// could otherwise run first) - deliberately two separate named registries,
// not one shared one, so a future character can't accidentally register at
// the wrong timing. Chronox's Rewind drift-correction and Athena's
// curse-mirror are still NOT migrated to either hook (see damagePipeline.js's
// own comments at each) - Rewind's runs BEFORE the KO branch and reads
// heartsBefore/target.hearts directly rather than a `ctx.amountDealt`
// shape, and Athena's needs preClearCursedId which is captured earlier in
// applyDamage for a reason specific to the KO branch's own timing.
const callbacks = new Map();

export function registerOnHitLanded(characterId, callback) {
  callbacks.set(characterId, callback);
}

export function runOnHitLanded(target, game, log, ctx) {
  const callback = callbacks.get(target.id);
  return callback ? callback(target, game, log, ctx) : undefined;
}
