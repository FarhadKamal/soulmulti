// Generic dispatcher for "someone (possibly not me) just died" reactions -
// the mirror image of onOwnDeath.js's "MY own death" hook, and a sibling to
// onOtherRevived.js's "someone else came back to life" hook. NOT one of the
// 29 taxonomy categories itself, but a lifecycle hook Kill-Claim-style
// mechanics hang off of (currently only Grimtal's Grim Strike own-kill/
// unclaimed-kill bookkeeping).
//
// Dispatched to EVERY registered callback on EVERY KO in the game
// (including the dying character's own module, if it happens to register
// here too - none currently do), since any number of different characters
// could independently care about "somebody died." Each callback decides
// for itself whether the death is relevant and who gets credit. Same
// zero-import-registry pattern as onOtherRevived.js, for the same
// circular-import reason.
const callbacks = [];

export function registerOnAnyDeath(callback) {
  callbacks.push(callback);
}

// `diedCharacterId`: who just died. `sourceCharacterId`/`isMirror`: who/what
// dealt the killing blow, so a callback can attribute credit correctly
// (e.g. "was this MY OWN direct kill, or someone/something else's").
export function runOnAnyDeath(diedCharacterId, sourceCharacterId, isMirror, game, log) {
  for (const callback of callbacks) {
    callback(diedCharacterId, sourceCharacterId, isMirror, game, log);
  }
}
