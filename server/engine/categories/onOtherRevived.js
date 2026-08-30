// Generic dispatcher for "someone else came back to life" cleanup - the
// mirror image of onOwnDeath.js's "my own death" hook. NOT one of the 29
// taxonomy categories itself, but a lifecycle hook Rebirth (#21) hangs off
// of: when a character revives (currently only Blade's Rebirth), every
// OTHER character whose own state might reference the revived character by
// id (a mark, a curse, a grudge count, a frozen/silenced/poisoned target, a
// stale Rewind snapshot) gets a chance to clear that stale reference, so
// the revived character genuinely "comes back fresh."
//
// Unlike onOwnDeath (keyed by ONE character id, the one who died), this is
// dispatched to EVERY registered module in turn, since any number of
// different characters could be independently tracking the now-revived
// character by id. Same zero-import-registry pattern as onOwnDeath.js/
// dodgeDefenseRegistry.js, for the same circular-import reason
// (damagePipeline.js cannot import an ability file directly).
const callbacks = [];

export function registerOnOtherRevived(callback) {
  callbacks.push(callback);
}

// `revivedCharacterId` is who came back; each registered callback decides
// for itself whether it holds any stale reference to that id and clears it
// if so. Never called for the revived character's own module (that's
// onOwnDeath/the reviving character's own execute() path's job, not this
// hook's) - callers should filter that out if a module happens to register
// both hooks (none currently do).
export function runOnOtherRevived(revivedCharacterId, game, log) {
  for (const callback of callbacks) {
    callback(revivedCharacterId, game, log);
  }
}
