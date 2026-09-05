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
//
// Return values ARE collected and merged (confirmed necessary 2026-09-05,
// added for Athena's Divine Judgment - see athena.js's own registration):
// a callback that itself calls applyDamage (a second, real kill triggered
// by this death) needs its own deferred log entry threaded back through
// applyDamage's `result`, same "defer it, don't push here" pattern as
// Athena's curse-mirror/Blade's Rebirth/Rowan's Mirror Reflect all already
// use - pushing directly to `log` from inside this callback lands it
// BEFORE the triggering action's own log line, since this fires mid-way
// through applyDamage, before the caller's own log.push() for that action.
// Confirmed live bug: "Divine Judgment falls upon Tharox - KO!" appeared
// BEFORE "Blade used Blood Hunt on Athena - 1 damage - KO!" in a real
// match log - the trigger entry was being pushed directly inside the
// callback instead of returned and deferred. Every registered callback
// returning a plain object gets merged onto one shared result (later
// callbacks' keys win on collision, though in practice no two callbacks
// are expected to return the same key).
export function runOnAnyDeath(diedCharacterId, sourceCharacterId, isMirror, game, log) {
  let merged;
  for (const callback of callbacks) {
    const extra = callback(diedCharacterId, sourceCharacterId, isMirror, game, log);
    if (extra) merged = { ...merged, ...extra };
  }
  return merged;
}
