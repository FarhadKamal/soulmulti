// Reactive per-character "action flash" portraits - reimplements the main
// game's dashboardScreen.js setXxx()/characterCard.js priority-chain system
// against the multiplayer server's action log instead of live client-side
// mutation. Same trigger conditions (see setter table extracted from the
// main game), same 1600ms flash duration, same idle/untouched-since-last-
// turn pattern for the 8 "idle portrait" characters.
import { v } from './assetVersion.js';
import { CHARACTER_IDS } from './characters.js';

const FLASH_DURATION_MS = 1600;

// Rowan's Petrify (hearts<=3 one-time bonus action) - unlike every other
// visual in this file, its "everyone turns to stone" effect has no fixed
// duration at all: it lasts until Rowan's own REAL follow-up action
// resolves, which could be seconds (a bot) or much longer (a human still
// deciding). Confirmed live bug, 2026-09-10: an earlier version tracked
// this as purely client-local module state, set/cleared by watching the
// log-entry sequence (a 'petrify' entry sets it, the next entry with
// characterId === 'rowan' clears it) - this had no source of truth to fall
// back on if a broadcast's exact entry sequence didn't line up the way the
// client assumed, and it silently never displayed correctly for at least
// one real player (root cause never fully isolated). Fixed by reading REAL
// serialized server state instead (character.special.petrifyPending,
// rowan.js/index.js) - same "read directly off broadcast game state, never
// infer client-side" pattern Fowl Play's isChicken, Melyssa's controlling,
// and Draxus's deathproofActive already use. See isPetrifyActive below.
export function isPetrifyActive(game) {
  return !!game.characters.rowan?.special?.petrifyPending;
}

// Confirmed ruling (2026-09-03): idle animations (checkIdlePortrait below)
// only ever play through this round of the match - round 4 onward, no
// character flashes to their idle pose again for the rest of that match,
// regardless of health/hero.
const IDLE_PORTRAIT_MAX_ROUND = 3;

// Tharox's Earthshatter portrait stays up much longer than the normal
// 1600ms every other flash uses - confirmed ruling: the image shouldn't
// revert back to idle while the ground-shattering sound effect (~5.2s, see
// sound.js's EARTHSHATTER_SOUND_LOCK_MS) is still playing out. 4.5s rather
// than the sound's own full length, per explicit choice.
const EARTHSHATTER_FLASH_DURATION_MS = 4500;

// Chronox's World Stops portrait similarly stays up longer than the
// default flash - sized to roughly match its own voice line (~4.68s) and
// sound effect (~4.03s, see sound.js's ACTION_SOUND.worldStops) so the
// image doesn't revert to idle while either is still playing out.
const WORLD_STOPS_FLASH_DURATION_MS = 4500;

// Boingo's Fowl Play cast portrait - matches the same 4.5s default every
// other multi-round special uses (Earthshatter/Grim Barrage/World Stops).
const FOWL_PLAY_FLASH_DURATION_MS = 4500;

// Athena's Divine Judgment TRIGGER moment (the marked victim's own death,
// not the cast) - same 4.5s scale as every other dramatic multi-beat
// special above, so the shared struck-down art has time to actually read
// before the victim's normal koed.jpg portrait would otherwise take over.
const DIVINE_JUDGMENT_TRIGGER_FLASH_DURATION_MS = 4500;

// Oraclus's Prophecy of Doom TRIGGER moment (the meteor strike hitting
// everyone when he dies) - same 4.5s dramatic-multi-beat scale as Divine
// Judgment's own trigger above.
const PROPHECY_OF_DOOM_TRIGGER_FLASH_DURATION_MS = 4500;

// Ashka's Vengeance (Kaelis's hearts<=3 passive) - the VICTIM's own
// ashka_strike.jpg flash, bumped to 3s per direct request (2026-09-08) so
// the bird-strike image has more time to read on the victim's tile.
const ASHKAS_VENGEANCE_STRIKE_FLASH_DURATION_MS = 3000;

// Zerathys's Soul Swap victim reaction (soul_drain.jpg) - bumped to 3s per
// direct request (2026-09-25), same duration as Ashka's Vengeance's own
// victim flash, so the reaction has more time to read on the target's tile
// than the default 1.6s.
const SOUL_DRAIN_FLASH_DURATION_MS = 3000;

// Akyros's Shadow Seal (replaces Shadow Army) - both the cast
// (shadow_seal.jpg) and every affected victim's own shadow_seal_strike.jpg
// use the same 4.5s multi-beat scale as Earthshatter/Grim Barrage above,
// since it's the same shape (one cast, multiple simultaneous victim
// reactions - no damage dealt, but the visual beat is the same).
const SHADOW_SEAL_FLASH_DURATION_MS = 4500;

// Melyssa's Friendship (Redirect Bond, design-locked 2026-09-20, replaces
// Full Control) - the bond-forming moment (both her own cast flash and the
// friend's own friendship_bond.jpg reaction) uses the same 4.5s dramatic
// multi-beat scale as every other special-cast reaction in this file.
const FRIENDSHIP_FLASH_DURATION_MS = 4500;

// The protects_melyssa.jpg reaction - shown on MELYSSA's OWN tile whenever
// a redirect actually happens (an attack meant for her landed on her
// friend instead). Still shorter than the cast/bond-forming beat above -
// this can fire on EVERY hit she'd otherwise have taken for the rest of the
// match while the bond holds, not a one-time dramatic moment - but bumped
// past the default hit-flash duration per direct request (2026-09-21) so
// the reaction has more time to actually read.
const PROTECTS_MELYSSA_FLASH_DURATION_MS = 2500;

// Marin's Lifebond (Pool & Redistribute #34 + No Threat #12) - every living
// character's own lifebond.jpg flashes at once, same 4.5s multi-beat scale
// as Shadow Seal/Earthshatter/Grim Barrage above (one cast, multiple
// simultaneous reactions across the board).
const LIFEBOND_FLASH_DURATION_MS = 4500;

// Blade's Blood Frenzy (hearts<=3 one-time special) - same 4.5s multi-beat
// scale as Shadow Seal above, covering his own cast pose for the whole
// 2-5 strike burst duration (no dedicated per-victim art - confirmed
// ruling: these are otherwise ordinary Blood Hunt hits, just randomly
// targeted, so the normal generic hit-flash/shake effect already covers
// each victim without any new asset work).
const BLOOD_FRENZY_FLASH_DURATION_MS = 4500;

// Velorya's Moonlit Theft (Siphon #35) - same 4.5s multi-beat scale as
// Lifebond/Shadow Seal above (one cast, multiple simultaneous victim
// reactions, though here only ever the shield-capable subset of heroes).
const MOONLIT_THEFT_FLASH_DURATION_MS = 4500;

// Resurrection Gamble (Draxus's Cheat Death, taxonomy #32) - a successful
// revival reuses the SAME sound effect as Deathless Fury's own cast
// (assets/sounds/deathless_fury.mp3, confirmed ruling 2026-09-06: "same
// mp3 deathless_fury"), so the flash duration is sized to match that same
// cast's own scale rather than a longer dramatic multi-beat special.
const CHEAT_DEATH_REVIVE_FLASH_DURATION_MS = FLASH_DURATION_MS;

// Grimtal's power.jpg follow-up: fires AFTER his own strike flash has fully
// finished playing (not simultaneously), same "let the first beat read
// before the second starts" sequencing Rowan's mirror-shard effect uses
// (see actionEffects.js's MIRROR_SEQUENCE_DELAY_MS) - here the gap is the
// full FLASH_DURATION_MS itself, since the thing being sequenced IS another
// portrait flash sharing this exact same timer/slot.
const GRIMTAL_POWER_DELAY_MS = FLASH_DURATION_MS;

// Per-character currently-flashing image path, cleared after
// FLASH_DURATION_MS. Keyed by characterId (not a Set, since only one flash
// image can show per character at a time - a later flash simply overwrites
// an earlier one, matching the main game's priority chain naturally
// collapsing to "whichever fired most recently").
const activeFlash = new Map(); // characterId -> { src, timer }

// Tracks each idle-portrait character's hearts as of their last turn start,
// to detect "untouched since last turn" - same reasoning as
// athenaHeartsAtLastTurnStart etc. in the main game.
const heartsAtLastTurnStart = new Map(); // characterId -> number | null

// The flash's own expiry timer doesn't get a fresh server broadcast to
// trigger a re-render off of (the server has no idea this is a purely
// client-side, timed visual effect) - main.js registers its rerender()
// here once at startup so the portrait actually reverts when the flash
// duration elapses, same as the main game's own setXxx() calling render()
// inside its setTimeout.
let onFlashExpired = () => {};
export function registerFlashRerender(fn) {
  onFlashExpired = fn;
}

// Boingo's Fowl Play - the ONLY portrait images allowed to flash on a
// chickenified character, no matter which call site tries to set one.
// Confirmed live reports: an idle-flash (checkIdlePortrait, fixed
// separately) AND a dodge-shaped animation both slipped through while a
// character was a chicken, because this file has ~15 different setFlash()
// call sites scattered across handleLogEntryForFlash's big per-actionId
// switch, handleDodgeForFlash, handleLaughing, queueGrimtalPowerFlash, and
// checkIdlePortrait - auditing and gating every one of them individually
// is exactly the kind of thing that's easy to miss one of (as just
// happened). This is the single low-level choke point EVERY one of those
// routes through, so gating here is the one fix that can never miss a
// future call site either. A chickenified character genuinely can't
// trigger any hero-specific action anymore (their whole kit is hidden
// server-side - see turnEngine.js's getLegalActions), so any attempt to
// flash something other than their generic chicken art onto them here
// reflects a stale/indirect trigger (an idle check, a delayed queued
// flash, a leftover Jester Ball sequence started before they turned into
// a chicken, etc.) - silently dropped rather than shown.
// Per-hero chicken art (2026-09-04) - every character except Boingo (who
// can never be chickenified) has its own chicken/chicken_attack/
// chicken_hit/chicken_roast set under assets/images/<id>/, replacing the
// original shared assets/images/boingo/chicken*.jpg set. chickenImagePath
// below is the single helper every call site uses to build the right path
// for whichever character is currently involved.
function chickenImagePath(characterId, suffix) {
  return `assets/images/${characterId}/chicken${suffix}`;
}

const CHICKEN_FLASH_PATHS = new Set([
  ...CHARACTER_IDS.filter((id) => id !== 'boingo').flatMap((id) => [
    chickenImagePath(id, '.jpg'),
    chickenImagePath(id, '_attack.jpg'),
    chickenImagePath(id, '_hit.jpg'),
  ]),
  'assets/images/boingo/foul_play.jpg',
]);

// Populated by every setFlash caller in this file that already has `game`
// in scope, via registerChickenCheck below - setFlash itself has no
// direct access to game/character state, only characterId/src.
let isCurrentlyChicken = () => false;
export function registerChickenCheck(fn) {
  isCurrentlyChicken = fn;
}

// Rowan's Frog Curse - same defense-in-depth reasoning as CHICKEN_FLASH_PATHS/
// isCurrentlyChicken above, scoped down since a frog has NO substitute
// action at all (unlike a chicken, which still gets chickenAttack) - only
// the persistent frog.jpg portrait (rendered via battleScreen.js's own
// isFrog branch, not through setFlash), Rowan's own cast flash, and the
// victim's own frog_dodge.jpg (fired from handleDodgeForFlash below, one
// per possible victim hero since a frog's jump-away pose stays consistent
// with their own design) are ever legitimate while a character is frogged.
// A stale/indirect hero-specific flash attempt should never reach a
// frogged character's tile at all.
const FROG_FLASH_PATHS = new Set([
  'assets/images/rowan/frog_curse.jpg',
  ...CHARACTER_IDS.filter((id) => id !== 'rowan').map((id) => `assets/images/${id}/frog_dodge.jpg`),
]);
let isCurrentlyFrog = () => false;
export function registerFrogCheck(fn) {
  isCurrentlyFrog = fn;
}

// Debug mode's own call history (2026-09-21, user request: "you can add
// more options on details logs" - a follow-up to a live report that
// choke.jpg still visibly played on a dodged Self Choke despite the
// server data being confirmed correct via debug-mode's raw-field
// annotations; static code tracing alone couldn't find the cause, and
// console logging was declined). Records every setFlash call actually
// made (character, image path, which log entry index it was processing at
// the time), so battleScreen.js's own debug annotation can show what the
// CLIENT actually decided to render for each entry, not just what the
// SERVER sent - if choke.jpg genuinely fires here for a dodge, this proves
// it's a real portraitFlash.js bug still to find; if it never fires here
// but still visibly shows, the bug is downstream of setFlash entirely
// (the render/consumption side, getFlashSrc's own callers in
// battleScreen.js), a different place to look than anything checked so
// far. Bounded ring buffer so a long match can't leak memory - sized well
// above what even a long match's worth of setFlash calls should reach
// (most log entries trigger 0-2 calls; a match with several hundred real
// events would still fit comfortably under this).
const FLASH_CALL_HISTORY_LIMIT = 2000;
let flashCallHistory = [];
let currentLogEntryIndex = -1;
// Confirmed real gap, 2026-09-22 (see net.js's own recordWireDiag comment
// for the full reasoning) - the log-entry-index-keyed traces in this file
// (flashCallHistory/flashSnapshotHistory) had no wall-clock timestamp at
// all, only which entry index they belonged to. That made them
// impossible to cross-reference against getRenderTrace (wall-clock only)
// or the live on-screen clock without GUESSING at message arrival timing,
// which caused a real mis-attributed correlation in a stuck-portrait
// investigation. Records Date.now() the moment each log entry index is
// first dispatched, so battleScreen.js can print it directly alongside
// that entry's own debug annotation - one shared timeline, no inference
// needed.
const logEntryDispatchTime = new Map();
export function setDebugLogEntryIndex(index) {
  currentLogEntryIndex = index;
  if (!logEntryDispatchTime.has(index)) logEntryDispatchTime.set(index, Date.now());
}
export function getLogEntryDispatchTime(index) {
  return logEntryDispatchTime.get(index) ?? null;
}
export function getFlashCallHistory() {
  return flashCallHistory;
}

function setFlash(characterId, src, durationMs = FLASH_DURATION_MS) {
  if (isCurrentlyChicken(characterId) && !CHICKEN_FLASH_PATHS.has(src)) return;
  if (isCurrentlyFrog(characterId) && !FROG_FLASH_PATHS.has(src)) return;
  // Confirmed real anomaly, 2026-09-22: a fully-timestamped, cross-
  // referenced trace (getRenderTrace + getLogEntryDispatchTime) proved
  // illyra/choke.jpg gets set in exact sync with a DODGED Self Choke
  // entry, even though every code path that could plausibly do this
  // (this file's own selfChoke branch, handleDodgeForFlash, the generic
  // switch) was individually re-checked and should not fire under these
  // conditions - the entry's own flash-call-history/snapshot annotations
  // even show illusion.jpg as the correct result immediately after
  // processing, yet the render trace shows choke.jpg was genuinely
  // active moments later. Capturing a real JS stack trace on every
  // setFlash call is the one thing that can name the ACTUAL call site
  // unambiguously, however well-hidden - a stack trace can't be wrong
  // about which function called it, unlike inferring from code reading.
  const stack = new Error().stack;
  flashCallHistory.push({ characterId, src, logEntryIndex: currentLogEntryIndex, stack, t: Date.now() });
  if (flashCallHistory.length > FLASH_CALL_HISTORY_LIMIT) flashCallHistory.shift();
  const existing = activeFlash.get(characterId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    activeFlash.delete(characterId);
    onFlashExpired();
  }, durationMs);
  // setAt records which dispatch batch this flash was set in (see
  // currentBatchToken below) - lets checkIdlePortrait tell "just set this
  // exact broadcast, don't stomp it" apart from "set several broadcasts
  // ago and simply hasn't expired yet," which its plain activeFlash.has()
  // check used to conflate (see checkIdlePortrait's own comment for the
  // live bug this caused).
  activeFlash.set(characterId, { src, timer, setAt: currentBatchToken });
}

// Incremented once per processNewLogEntries call (main.js) via
// beginFlashDispatchBatch below - a monotonic token identifying "this
// broadcast's dispatch pass," independent of wall-clock time (which
// setTimeout delivery can't be trusted against under tab throttling/heavy
// synchronous work - the exact failure mode that caused the stale-choke-
// on-Illyra bug this token fixes).
let currentBatchToken = 0;
export function beginFlashDispatchBatch() {
  currentBatchToken += 1;
}

// Debug mode's own render-time snapshot (2026-09-21, follow-up to a live
// report where the flash-CALL trace above showed nothing wrong for the
// exact moment/entry the user reported seeing choke.jpg on Illyra despite
// a confirmed dodge - ruling out "the wrong image was explicitly SET" but
// NOT ruling out "a STALE image from an earlier setFlash call was still
// active/showing" or a render-order issue). Snapshots activeFlash's FULL
// current state (every character with anything active right now, not just
// the one this entry's own setFlash calls touched) at the exact moment
// main.js finishes dispatching one log entry's full effect chain - lets
// the debug annotation show "what was actually live and would have been
// rendered right after this entry," independent of whether THIS entry's
// own setFlash calls were the ones that set it.
let flashSnapshotHistory = [];
export function snapshotActiveFlashForDebug(logEntryIndex) {
  const snapshot = {};
  for (const [characterId, { src }] of activeFlash.entries()) snapshot[characterId] = src;
  flashSnapshotHistory.push({ logEntryIndex, snapshot });
  if (flashSnapshotHistory.length > FLASH_CALL_HISTORY_LIMIT) flashSnapshotHistory.shift();
}
export function getFlashSnapshotHistory() {
  return flashSnapshotHistory;
}

// Confirmed real bug, 2026-09-22 (live report + user's own direct catch:
// "rowan even was not even there on the game" - Rowan appeared in a debug
// trace annotation for a match that never had him in its roster at all).
// Root cause: these debug-only history arrays were never cleared between
// matches - only game.log's own read position (main.js's lastLogLength)
// reset for a fresh match, so a brand-new match's entry index 5 could
// still match against a STALE logEntryIndex: 5 record left over from a
// COMPLETELY DIFFERENT earlier match, showing that earlier match's
// characters as if they belonged to the current one. This was a bug in
// the debug TOOLING itself, not the real game/animation logic - every
// "wrong character" trace result investigated under this bug should be
// re-examined with fresh eyes once reproduced again post-fix, since the
// underlying data was never trustworthy across a match boundary. Called
// from main.js at the exact same two points lastLogLength itself resets.
export function resetFlashDebugHistoryForNewMatch() {
  flashCallHistory = [];
  flashSnapshotHistory = [];
  logEntryDispatchTime.clear();
  entrySnapshotHistory.length = 0;
}

// Render-event trace (2026-09-22) - follow-up to a live report the prior
// 5 trace layers couldn't explain: user confirmed seeing choke.jpg on
// Akyros immediately around a CONFIRMED-dodged Self Choke (the debug
// snapshot right after that log entry shows dodge.jpg, not choke.jpg,
// ruling out the setFlash-call layer), but described it as "happening
// faster" than a screenshot could catch - too fast for the ~1.6s normal
// flash duration to explain as a genuinely-set, sustained image. All
// existing snapshot/call-history tracing only fires once per WHOLE BATCH
// of log entries (main.js's processNewLogEntries loop, after every entry
// in one game-state message has been dispatched) - it can't see a
// separate, INDEPENDENT rerender triggered by a flash timer expiring
// (portraitFlash.js's own onFlashExpired callback, wired to main.js's
// rerender() - see registerFlashRerender), which happens on its own
// setTimeout schedule, decoupled from any server message. Since
// battleScreen.js's renderBattle does `root.innerHTML = ''` and rebuilds
// the ENTIRE board from scratch on every single render (message-driven OR
// timer-driven), any character's flash expiring anywhere forces every
// OTHER character's portrait to be recomputed too - a render event class
// this file's debug tooling never separately recorded before. This trace
// records every actual getFlashSrc() call (i.e. every real render,
// whichever triggered it) with a wall-clock timestamp and what it
// returned, so a burst of renders tighter than the eye/screenshot can
// follow becomes visible as a sequence of real timestamped entries
// instead of being invisible between the coarser per-batch snapshots.
const RENDER_TRACE_LIMIT = 4000;
let renderTrace = [];
export function getRenderTrace() {
  return renderTrace;
}
export function resetRenderTraceForNewMatch() {
  renderTrace = [];
}

export function getFlashSrc(characterId) {
  const entry = activeFlash.get(characterId);
  const src = entry?.src ?? null;
  renderTrace.push({ t: Date.now(), characterId, src });
  if (renderTrace.length > RENDER_TRACE_LIMIT) renderTrace.shift();
  return src ? v(src) : null;
}

// Two persistent (non-timed) portrait overrides, checked directly against
// live character state rather than the log - same priority position as the
// main game's characterCard.js (both sit below every timed flash, above
// the KO/injured/default fallback): Velorya's hidden/eclipsed look while
// untargetable, and Blade's "back from the dead" look for the rest of the
// match once Rebirth has triggered.
export function getPersistentPortrait(character) {
  if (character.isKO) return null;
  // Boingo's Fowl Play - no hero-specific persistent portrait (Blade's
  // post-Rebirth alive.jpg, Velorya's hided.jpg, Melyssa's mind-control
  // selection art, Draxus's immortality.jpg) may ever override the
  // generic chicken portrait while chickenified. Confirmed live report:
  // "after rebirth by blade. i then casted chicken foul on blade..blade
  // rebirth image was showing most of the time" - this function sits
  // ABOVE the chicken-portrait check in battleScreen.js's own priority
  // chain, so a persistent hero portrait always won regardless of chicken
  // status, same class of gap as checkIdlePortrait's own missing guard
  // (fixed separately).
  if (character.isChicken) return null;
  // Rowan's Frog Curse - same reasoning as the isChicken guard just above.
  // Confirmed real bug, 2026-09-25 (live report: "i did not see blade turn
  // into frog animation" - Blade had already used Rebirth earlier in the
  // match, so `special.rebirthUsed` was true, and the alive.jpg branch
  // further down unconditionally won over frog.jpg for the entire duration
  // of the curse, since this function sits ABOVE battleScreen.js's own
  // isFrog check in the render priority chain - the exact same class of
  // gap the isChicken guard above was already fixed for once (see its own
  // comment: "a persistent hero portrait always won regardless of chicken
  // status"), just never extended to isFrog when Frog Curse was added.
  if (character.isFrog) return null;
  // Held for the entire duration of a Mind Control sequence (from puppet
  // selection through the puppeted action and any nested follow-up) -
  // character.special.controlling is real, serialized character state, set
  // by melyssa.js's own mindControl.execute() and cleared by
  // finishMelyssaTurn (server/index.js) once the whole sequence resolves.
  if (character.id === 'melyssa' && character.special?.controlling) return v('assets/images/melyssa/mind_control_selection.jpg');
  if (character.id === 'velorya' && character.untargetable) return v('assets/images/velorya/hided.jpg');
  if (character.id === 'blade' && character.special?.rebirthUsed) return v('assets/images/blade/alive.jpg');
  // Held from the moment Deathless Fury is cast until his own next
  // onTurnStart clears deathproofActive (draxus.js) - persists across
  // however many intervening turns the death-proof window spans, same
  // "real serialized state, not a client timer" pattern as Melyssa's own
  // held portrait above.
  if (character.id === 'draxus' && character.special?.deathproofActive) return v('assets/images/draxus/immortality.jpg');
  // Resurrection Gamble (Cheat Death, taxonomy #32) - same "sticky, for the
  // rest of the match" shape as Blade's own post-Rebirth alive.jpg just
  // above, confirmed ruling: "after he alive. that alive image will show
  // rest of the match until he koed again" - hasRevivedOnce never clears
  // itself (unlike deathproofActive), so this checked BEFORE the
  // deathproofActive branch would be wrong priority if he somehow also had
  // it active; in practice the two never overlap (Deathless Fury requires
  // being alive to cast, Cheat Death only fires while dead), so order
  // between them doesn't matter here. Also covers his injured display -
  // confirmed ruling: "his potrait/injured image after alive is alive.jpg"
  // - battleScreen.js's own injured-threshold branch never runs for him
  // once this persistent override wins first, same priority position every
  // other persistent portrait here already relies on.
  if (character.id === 'draxus' && character.special?.hasRevivedOnce) return v('assets/images/draxus/alive.jpg');
  // Grimtal's Beast Form (Death-Triggered Reversion #36) - held for the
  // entire duration of the transformation, driven by real serialized state
  // (beastFormActive), same shape as Velorya's own untargetable-driven
  // hided.jpg above - it has no fixed timer, so this must be real ongoing
  // state read directly off the broadcast, not a client-local timed flash.
  // Overrides idle/injured/his own attack-flash entirely while active
  // (checked at the same priority position every other persistent portrait
  // here already occupies), reverting automatically the instant
  // beastFormActive flips back false (see grimtal.js's registerOnAnyDeath).
  if (character.id === 'grimtal' && character.special?.beastFormActive) return v('assets/images/grimtal/beast.jpg');
  return null;
}

// Every character's idle/untouched portrait ("own turn started, took no
// damage since last turn, above half health" flash). Every hero's file now
// lives at the same path shape (confirmed rename, 2026-09-15 - 9 heroes
// used to have their own themed filename here, e.g. blade/guitar.jpg,
// athena/apple.jpg; renamed to idle.jpg across the board for consistency
// with the 7 heroes that already used it), so this is a plain computed
// path rather than a per-hero lookup table.
function idleImagePath(characterId) {
  return `assets/images/${characterId}/idle.jpg`;
}

// Per-character idle-flash duration overrides (falls back to the shared
// FLASH_DURATION_MS for everyone not listed here). Grimtal's flute-playing
// idle image is a quieter character beat meant to linger longer than a
// normal 1.6s flash - per explicit request, held roughly double that.
const IDLE_DURATION_MS = {
  grimtal: 3000,
};

// Call once per character at the moment their own turn starts (i.e. when
// they first appear as actingCharacterId after not having been the actor
// on the previous broadcast) - see main.js's turn-start edge detection.
// Returns true if the character was genuinely in the "idle" state
// (untouched since last turn, above half health) - main.js uses this same
// boolean to decide whether to also play that character's idle voice line
// (voice.js's playIdleVoice), so there's exactly one definition of "idle"
// shared by both the portrait and the voice line, not two separately
// maintained checks that could drift apart.
export function checkIdlePortrait(character, round) {
  if (character.isKO) return false;
  // Confirmed ruling (2026-09-03): idle animations only ever play during
  // the first 3 rounds of a match - round 4 onward, a character just shows
  // their normal portrait even when fully untouched/healthy, no more idle
  // flash for the rest of that match. Applies to every hero uniformly
  // (this function is the single shared idle mechanism, not per-
  // character), unrelated to Boingo/Fowl Play specifically.
  if (round > IDLE_PORTRAIT_MAX_ROUND) return false;
  // Draxus's persistent immortality.jpg portrait (getPersistentPortrait
  // above) must never get stomped by a timed idle flash - setFlash's
  // activeFlash entries sit ABOVE the persistent-portrait check in
  // battleScreen.js's render priority, so an idle flash firing during his
  // death-proof window would incorrectly hide the immortal portrait for
  // its whole duration. Skip idle entirely while it's active.
  if (character.id === 'draxus' && character.special?.deathproofActive) return false;
  // Boingo's Fowl Play - same reasoning as the Draxus guard above: a
  // chickenified character's OWN hero-specific idle image (e.g.
  // illyra/idle.jpg) must never flash over the chicken.jpg portrait
  // override for as long as they're chickenified. Confirmed live report:
  // "chicken status. idle animation played!" - this check was simply
  // missing, so a chicken who went untouched for a turn briefly flashed
  // back to their own normal hero idle art mid-transformation.
  if (character.isChicken) return false;
  // Rowan's Frog Curse - same reasoning as the isChicken guard just above:
  // a frogged character's own hero-specific idle image must never flash
  // over the frog.jpg portrait override for as long as isFrog is true.
  if (character.isFrog) return false;
  const lastHearts = heartsAtLastTurnStart.has(character.id) ? heartsAtLastTurnStart.get(character.id) : null;
  const wasUntouched = lastHearts === null || character.hearts >= lastHearts;
  const isIdle = wasUntouched && character.hearts > character.maxHearts / 2;
  // Don't stomp a more specific flash that was JUST set for this same
  // broadcast (e.g. Akyros dodging the hit that ended up rotating turn
  // order straight to him - handleDodgeForFlash's akyros_dodge flash and
  // this idle-rose check both fire from the same game-state message, and
  // without this guard the idle check (called second, from main.js) would
  // silently overwrite the dodge portrait before it was ever rendered,
  // in the same synchronous tick). The main game avoids this entirely by
  // using separate boolean flags with dodge checked ahead of idle in its
  // own if/else chain - this activeFlash map has no such built-in
  // priority, so it has to be enforced here instead.
  // Confirmed real bug, 2026-09-22 (live report + screenshot: choke.jpg
  // visibly stuck on Illyra's own tile while she was "ACTING NOW", several
  // turns after the Self Choke hit that actually set it). This used to
  // check activeFlash.has(character.id) alone, which can't distinguish "a
  // flash was JUST set this exact broadcast, don't stomp it" (the only
  // case this guard is meant for) from "a flash from several broadcasts
  // ago is still sitting in activeFlash because its setTimeout fired late"
  // - background-tab timer throttling and bursts of synchronous work
  // (rapid bot turns) can both delay a timer well past its nominal
  // duration, so activeFlash.has() staying true is not proof the flash is
  // still "current." Now only treated as same-broadcast (and thus
  // protected from being overwritten) if its setAt token matches this
  // dispatch pass's own currentBatchToken (see setFlash/
  // beginFlashDispatchBatch) - anything older is stale and safe to
  // override with idle.jpg here, same as if nothing were active at all.
  const existingFlash = activeFlash.get(character.id);
  if (existingFlash && existingFlash.setAt === currentBatchToken) {
    heartsAtLastTurnStart.set(character.id, character.hearts);
    return false;
  }
  if (isIdle) {
    setFlash(character.id, idleImagePath(character.id), IDLE_DURATION_MS[character.id]);
  }
  heartsAtLastTurnStart.set(character.id, character.hearts);
  return isIdle;
}

// Boingo's "laughing" flash is the odd one out - triggered on the THROWER
// (thrownByCharacterId), not the acting character, from two different
// Jester Ball resolution outcomes (ball explodes on someone else, or gets
// returned to him) rather than from Boingo's own turn.
function handleLaughing(entry, game) {
  const thrownById = entry.type === 'jester-ball-take' ? findThrowerFor() : entry.boingoId;
  if (!thrownById) return;
  const thrower = game.characters[thrownById];
  if (!thrower || thrower.isKO) return;
  setFlash(thrownById, 'assets/images/boingo/laughing.jpg');
}

// jester-ball-take entries don't carry the original thrower's id directly
// in the broadcast log shape (the holder who took it is targetCharacterId,
// and by the time this entry is processed game.jesterBall has already been
// cleared to null) - so the thrower is tracked separately from the moment
// they cast jesterBall, for the life of that one throw.
let lastJesterBallThrowerId = null;
function findThrowerFor() {
  return lastJesterBallThrowerId;
}

// Grimtal's power.jpg: queued (not fired immediately) whenever ANY
// character on the board gets KO'd (his own damage now scales off the
// total KO count, not just kills he personally lands) - the caller
// (main.js's queueGrimtalPowerIfAlive) already checks he's alive and isn't
// the one who died before calling this. Delayed so it plays strictly AFTER
// whatever strike/flash is already showing has fully finished, not layered
// on top of it. game is captured via closure at call time rather than
// passed through the timer so a stale isKO check can't read from an
// outdated snapshot.
export function queueGrimtalPowerFlash(characterId, game) {
  setTimeout(() => {
    if (!game.characters[characterId]?.isKO) setFlash(characterId, 'assets/images/grimtal/power.jpg');
    onFlashExpired();
  }, GRIMTAL_POWER_DELAY_MS);
}

// Confirmed real anomaly, 2026-09-22: a stack-trace-level trace proved
// setFlash('illyra', '.../choke.jpg') fires from THIS function's own
// selfChoke branch (line ~593) for a log index whose displayed text is a
// DODGED Self Choke - which the branch's own !entry.dodged gate should
// have blocked. Records the RAW entry object's own relevant fields
// (type/actionId/characterId/targetId/dodged) exactly as THIS function
// sees them at evaluation time, tagged by logEntryIndex - if these ever
// disagree with what the SAME entry's text/other annotations show, that
// proves the entry object itself carries different data than expected at
// the moment this code runs (e.g. two different entries' data aliased
// together, or a mutation between push and read), not a logic error in
// the gate itself.
export function getLastFlashEntrySnapshots() {
  return entrySnapshotHistory;
}
const entrySnapshotHistory = [];
const ENTRY_SNAPSHOT_LIMIT = 2000;

// Processes one NEW log entry (already known not to have been seen before)
// and fires whatever flash(es) it implies. Call in log-append order.
export function handleLogEntryForFlash(entry, game) {
  const isKO = (id) => game.characters[id]?.isKO;
  entrySnapshotHistory.push({
    logEntryIndex: currentLogEntryIndex,
    type: entry.type,
    actionId: entry.actionId,
    characterId: entry.characterId,
    targetId: entry.targetId,
    targetCharacterId: entry.targetCharacterId,
    dodged: entry.dodged,
    t: Date.now(),
  });
  if (entrySnapshotHistory.length > ENTRY_SNAPSHOT_LIMIT) entrySnapshotHistory.shift();

  // Self Choke gets its own dedicated flash on Melyssa herself - checked
  // first and returns, since its entry's characterId is already 'melyssa'
  // directly (she's the true actor, per server/index.js's executeSelfChoke)
  // and must not ALSO trigger the generic controllingMelyssaId flash below.
  // The REAL damage lands on entry.targetId (the puppet forced into this),
  // not on Melyssa - confirmed live gap, 2026-09-10: the puppet who
  // actually takes 2 real unshielded damage had zero portrait reaction of
  // its own (only the CSS choke-ring/ghost-hand overlay, no per-hero
  // image), while Melyssa's own tile flashed as if she were the one hurt.
  // Per-victim art added the same way Divine Judgment/Prophecy of Doom/
  // Shadow Seal/Petrify already do - assets/images/<victimId>/choke.jpg,
  // one per hero (all 15 possible puppets, everyone except Melyssa
  // herself, who can never be forced into her own Self Choke). Layered
  // ALONGSIDE the existing CSS skeleton-hand/choke-ring effect for now
  // (not replacing it) - confirmed ruling: "we will remove that css
  // animation.. but not now."
  // friendshipSelfChoke (the forced 1v1-with-your-own-friend endgame,
  // turnEngine.js) is a SEPARATE server-side implementation from the
  // normal puppeted selfChoke (server/index.js's executeSelfChoke) -
  // confirmed real bug, 2026-09-22 (live report: "melyssa choke cast
  // animation play. that is correct. supposed to play also rowan choke.jpg
  // animation also... but that does not play"). This client-side handler
  // only ever matched actionId === 'selfChoke', so the forced-endgame
  // variant fell through to the generic switch below (which has no
  // 'friendshipSelfChoke' case either) and silently played NEITHER
  // Melyssa's own cast flash NOR the friend's choke.jpg reaction. Folded
  // into the same branch since both are visually identical (dodge is no
  // longer even reachable here either, per the 2026-09-22 ignoresDodge fix
  // applied to both server-side paths - the !entry.dodged gate below is
  // now belt-and-braces, not load-bearing).
  if ((entry.actionId === 'selfChoke' || entry.actionId === 'friendshipSelfChoke') && entry.characterId === 'melyssa') {
    if (!isKO('melyssa')) setFlash('melyssa', 'assets/images/melyssa/self_choke.jpg');
    // Confirmed real bug, 2026-09-21 (live report): choke.jpg used to fire
    // UNCONDITIONALLY here, even when the puppet's own dodge passive
    // (Illyra's unconditional 50%, Akyros's per-attacker dodge, Marin's
    // Threefold Veil, Grimtal's Grim Ward - dodge legitimately still
    // applies against Self Choke, confirmed ruling, see project memory
    // soulclash_melyssa.md) blocked it entirely - the victim's tile showed
    // "being choked" immediately followed by its own separate 'dodge'
    // entry's "dodged it" reaction right after, a confusing contradictory
    // back-to-back sequence for something that never actually landed.
    // Gated on !entry.dodged (mirrors actionEffects.js's own
    // amountDealt > 0 gate for the choke-ring/ghost-hand CSS effect) so a
    // dodged choke shows ONLY Melyssa's own cast/attempt flash plus the
    // victim's normal dodge reaction - not both a fake hit AND a dodge.
    if (entry.targetId && !isKO(entry.targetId) && !entry.dodged) {
      setFlash(entry.targetId, `assets/images/${entry.targetId}/choke.jpg`);
    }
    return;
  }
  // The 50% chance her puppeted action simply fails - her own frustrated
  // reaction flash, checked BEFORE the generic controllingMelyssaId block
  // below (same early-return shape as Self Choke above), since this entry
  // also carries controllingMelyssaId and would otherwise get overwritten
  // by the generic mind_control_action.jpg flash instead.
  if (entry.type === 'mind-control-resist') {
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/melyssa/useless.jpg');
    return;
  }
  // Any puppeted action (real or a forced Jester Ball take/pass) additionally
  // flashes Melyssa's own portrait the instant it resolves - the puppet's
  // own portrait still separately flashes for the SAME entry via the
  // switch below (different characterIds in the activeFlash map, both
  // coexist). controllingMelyssaId is stamped server-side by
  // executeActionAsPuppet (turnEngine.js) onto every log entry a puppeted
  // action produces.
  if (entry.controllingMelyssaId && !isKO(entry.controllingMelyssaId)) {
    setFlash(entry.controllingMelyssaId, 'assets/images/melyssa/mind_control_action.jpg');
  }

  if (entry.type === 'special' && entry.actionId === 'friendship') {
    // Melyssa's Friendship (Redirect Bond, design-locked 2026-09-20,
    // replaces Full Control) - the cast flash on HER OWN tile still fires
    // via the generic switch below (case 'friendship'), this block handles
    // the FRIEND's own reaction art (friendship_bond.jpg, one per hero,
    // same per-victim-hero pattern as every other multi-hero art set in
    // this file).
    if (!isKO(entry.targetId)) {
      setFlash(entry.targetId, `assets/images/${entry.targetId}/friendship_bond.jpg`, FRIENDSHIP_FLASH_DURATION_MS);
    }
    // Deliberately NOT returning here - falls through to the generic
    // switch below so Melyssa's own 'assets/images/melyssa/friendship.jpg'
    // cast flash (case 'friendship') still fires exactly as before.
  }
  if (entry.type === 'special' && entry.actionId === 'jesterBall') {
    lastJesterBallThrowerId = entry.characterId;
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/boingo/throwing.jpg');
    return;
  }
  if (entry.type === 'jester-ball-return') {
    handleLaughing(entry, game);
    return;
  }
  // The ball passing THROUGH Boingo mid-sequence - same laughing beat as
  // the full return, just for a smaller checkpoint heal along the way.
  if (entry.type === 'jester-ball-checkpoint-heal') {
    handleLaughing(entry, game);
    return;
  }
  if (entry.type === 'jester-ball-take') {
    // Explodes on someone OTHER than Boingo - flash the thrower laughing,
    // per the main game's reasoning ("his mischief paid off either way").
    if (entry.targetCharacterId !== lastJesterBallThrowerId) handleLaughing(entry, game);
    return;
  }
  if (entry.type === 'hidden-mark') {
    // Akyros's own ability logs a dedicated 'hidden-mark' entry (never
    // 'attack'/'special'/'setup') rather than folding into the generic
    // switch below - matches the main game, which fires this flash
    // straight off the executed actionId rather than a log-entry type.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/akyros/hidden.jpg');
    return;
  }
  if (entry.type === 'curse') {
    // Athena's Curse Strike also logs its own dedicated type (never
    // 'attack'/'special'/'setup') - same reasoning as hidden-mark above.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/athena/curse.jpg');
    return;
  }
  if (entry.type === 'cheat-death') {
    // Resurrection Gamble (Draxus's Cheat Death, taxonomy #32) - a failed
    // roll (success: false) shows nothing at all, he's still just sitting
    // there KO'd (koed.jpg keeps showing via the normal isKO branch). A
    // successful roll flashes the revival burst - by the time this entry
    // is pushed, isKO has already flipped back to false (draxus.js's
    // executeCheatDeath sets it before pushing this entry), so the normal
    // isKO guard already reads correctly here without needing the
    // divine-judgment-trigger entry's own special-cased inversion above.
    if (entry.success && !isKO(entry.characterId)) {
      setFlash(entry.characterId, 'assets/images/draxus/alive.jpg', CHEAT_DEATH_REVIVE_FLASH_DURATION_MS);
    }
    return;
  }
  if (entry.type === 'divine-judgment-trigger') {
    // The TRIGGER moment (Athena's own death killing her marked victim) -
    // deliberately NOT gated on !isKO(entry.toCharacterId) like every
    // other flash in this file, since the victim IS KO'd by the time this
    // entry is even pushed (applyDamage already ran) - that's exactly the
    // moment this flash needs to show, overriding the plain koed.jpg for
    // DIVINE_JUDGMENT_TRIGGER_FLASH_DURATION_MS so the death reads as "the
    // pact," not a normal KO. Per-victim-hero art (confirmed ruling,
    // 2026-09-05: "no asset limitation... we will create for each hero") -
    // assets/images/<victimId>/judgement_strike.jpg (this exact spelling
    // is the real filename used, not "judgment_struck"), one per hero (all
    // 15 possible victims, everyone except Athena herself).
    if (entry.koTriggered) {
      setFlash(entry.toCharacterId, `assets/images/${entry.toCharacterId}/judgement_strike.jpg`, DIVINE_JUDGMENT_TRIGGER_FLASH_DURATION_MS);
    }
    return;
  }
  if (entry.type === 'prophecy-of-doom-trigger') {
    // The TRIGGER moment (Oraclus's own death raining a meteor strike on
    // EVERY other living character) - structurally different from Divine
    // Judgment's own single-victim trigger just above: loops entry.hits
    // and flashes EVERY victim, not gated on koTriggered per-victim (a
    // survivor who only took damage still shows the meteor impact art, not
    // just the ones it kills) - only requires amountDealt > 0 (a shield
    // that fully absorbed the hit shows nothing, matching every other
    // "did this actually land" flash gate in this file). Per-victim-hero
    // art, same asset-naming pattern as judgement_strike.jpg -
    // assets/images/<victimId>/doom_strike.jpg, one per hero (all 15
    // possible victims, everyone except Oraclus himself). Deliberately NOT
    // gated on !isKO(hit.targetId) for a hit that DID KO them - same
    // reasoning as Divine Judgment's own trigger, the victim IS KO'd by
    // the time this entry is pushed, and that's exactly the moment this
    // flash needs to override the plain koed.jpg for.
    for (const hit of entry.hits || []) {
      if (hit.amountDealt > 0) {
        setFlash(hit.targetId, `assets/images/${hit.targetId}/doom_strike.jpg`, PROPHECY_OF_DOOM_TRIGGER_FLASH_DURATION_MS);
      }
    }
    return;
  }
  if (entry.type === 'prediction-result') {
    // Oraclus's Rune Vision resolving - its own dedicated log entry type
    // (server's resolveOraclusPredictionIfPending), same reasoning as
    // hidden-mark/curse above. Win and miss get visually distinct images
    // (see the win_prediction.jpg/loss_prediction.jpg design), unlike
    // every other flash pair in this file which all reuse ONE image with
    // different animation overlays for success/failure.
    if (!isKO('oraclus')) {
      setFlash('oraclus', entry.matched ? 'assets/images/oraclus/win_prediction.jpg' : 'assets/images/oraclus/loss_prediction.jpg');
    }
    return;
  }
  if (entry.type === 'ashka-heal') {
    // Kaelis's passive follow-up bird heal (Call Ashka's 2 free ticks) -
    // its own dedicated type, same reasoning as hidden-mark/curse above,
    // since it's not player-triggered and never carries an actionId.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/kaelis/bird.jpg');
    return;
  }
  if (entry.type === 'blood-drain') {
    // Blade's Blood Drain (design-locked 2026-09-23) - always-on passive,
    // fires whenever a 3rd-tick Blood Hunt/Blood Frenzy hit actually lands.
    // Own dedicated type, same "not player-triggered, no actionId"
    // reasoning as ashka-heal/beast-regen above - the triggering strike's
    // own attack flash already played from its own separate log entry
    // (pushed just before this one), so this is purely the follow-up
    // "feeding" beat right after.
    if (isKO(entry.characterId)) return;
    // Confirmed real bug, 2026-09-23 (live report: "blood drain animation
    // work but.. blood_frenzy image miss"). setFlash() has no queueing - it
    // synchronously overwrites whatever's currently showing on that tile
    // and clears its timer. When this entry follows a Blood Frenzy burst
    // (blade.js's own afterBloodFrenzy flag), the cast flash
    // (blood_frenzy.jpg) is still supposed to be showing for its own full
    // 4500ms (BLOOD_FRENZY_FLASH_DURATION_MS) - calling setFlash for the
    // drain immediately in the same dispatch batch cut that cast flash's
    // display time down to almost nothing. Delaying this call until the
    // cast flash's own duration has elapsed lets each one get its full,
    // separate moment instead of racing for the same tile. A normal single
    // Blood Hunt hit has no such competing flash, so it fires immediately
    // as before.
    if (entry.afterBloodFrenzy) {
      setTimeout(() => {
        if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/blade/blood_drain.jpg');
      }, BLOOD_FRENZY_FLASH_DURATION_MS);
      return;
    }
    setFlash(entry.characterId, 'assets/images/blade/blood_drain.jpg');
    return;
  }
  if (entry.type === 'beast-regen') {
    // Grimtal's Beast Form passive regeneration (own dedicated type, same
    // "not player-triggered, no actionId" reasoning as ashka-heal above) -
    // the persistent beast.jpg portrait (getPersistentPortrait) already
    // covers him for the rest of the transformation, so this is only ever
    // a brief flash on the turn it actually fires.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/grimtal/beast_heal.jpg');
    return;
  }
  if (entry.type === 'beast-form-end') {
    // Grimtal's Beast Form reversion - confirmed real gap, 2026-09-13: the
    // persistent beast.jpg portrait (getPersistentPortrait above) just
    // silently snaps back to his normal idle/human art the instant
    // beastFormActive flips false, with no transition moment shown at all.
    // This brief flash covers that instant - claws/hide visibly reverting
    // mid-change, same "own dedicated type, no actionId" reasoning as
    // ashka-heal/beast-regen above. getPersistentPortrait's own
    // beastFormActive check has already gone false by the time this
    // renders (the flag flips before the log entry is even pushed), so it
    // won't fight this flash - the persistent portrait naturally takes
    // over again once this flash's own timer expires.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/grimtal/beast_end.jpg');
    return;
  }
  if (entry.type === 'rebirth') {
    // Blade's Rebirth - confirmed real gap, 2026-09-14: getPersistentPortrait's
    // own rebirthUsed check (above) already flips to the persistent
    // alive.jpg the instant this triggers, with no transition moment for
    // the actual revival itself - same "own dedicated type, no actionId"
    // shape as beast-form-end just above, and same reasoning (the
    // underlying flag has already gone true by the time this log entry is
    // pushed, so this flash needs to override the persistent portrait
    // rather than compete with it). Deliberately NOT gated on
    // !isKO(entry.targetCharacterId) - he was never actually KO'd in the
    // first place (Rebirth intercepts the killing blow before applyDamage's
    // KO branch ever sets isKO=true), so there's no koed.jpg step in this
    // sequence at all (confirmed ruling, 2026-09-14: "Normal -> rebirth.jpg
    // flash -> alive.jpg", no koed step since he's mechanically never
    // dead). Once this flash's own timer expires, getPersistentPortrait's
    // alive.jpg naturally takes over for the rest of the match.
    setFlash(entry.targetCharacterId, 'assets/images/blade/rebirth.jpg');
    return;
  }
  if (entry.type === 'ashkas-vengeance-strike') {
    // Ashka's Vengeance (Kaelis's hearts<=3 passive, taxonomy: Pure Attack
    // #1 + Passive Action #23) - a fully automatic bonus strike, own
    // dedicated log type. Kaelis's OWN tile shows a phoenix-LESS reaction
    // shot (confirmed ruling: "she will also surprise at that time" -
    // Ashka has physically flown off, so her usual phoenix-beside-her art
    // would look wrong here) - assets/images/kaelis/surprise.jpg. The
    // VICTIM's own tile shows their own per-hero trigger image (confirmed
    // ruling: "we will create ashka is attaking for each hero"), same
    // per-victim-art pattern as Divine Judgment/Prophecy of Doom -
    // assets/images/<victimId>/ashka_strike.jpg, held for
    // ASHKAS_VENGEANCE_STRIKE_FLASH_DURATION_MS. Confirmed real bug,
    // 2026-09-16: the old gate here was "not gated on amountDealt>0... it
    // always lands unless the target already died" - written before
    // Grimtal's Beast Form existed, which is a SECOND way this can
    // correctly deal 0 despite Ashka's Vengeance's normal unblockable
    // nature (tryBeastFormImmunity in damagePipeline.js sits above every
    // ignoresShield/ignoresDodge/ignoresUntargetable flag, so it still
    // blocks this true-pure hit even though nothing else can) - live
    // report: "ashka should not even target grimtal in beast form... i
    // have seen ashka hit animation on grimtal during beast form." Now
    // explicitly gated on amountDealt>0 to catch this (and any other
    // future zero-damage source) generically, rather than re-special-
    // casing Beast Form here by name.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/kaelis/surprise.jpg');
    if (entry.amountDealt > 0 && (!isKO(entry.targetId) || entry.koTriggered)) {
      setFlash(entry.targetId, `assets/images/${entry.targetId}/ashka_strike.jpg`, ASHKAS_VENGEANCE_STRIKE_FLASH_DURATION_MS);
    }
    return;
  }
  if (entry.type === 'spell-discovered') {
    // Marin's 5 spells auto-activate the instant they're revealed - unlike
    // Rowan (whose discoveries stay flash-silent, since HIS spells are cast
    // separately later - that later cast is where his own flash lives),
    // this dedicated type IS the one moment worth flashing for 3 of her 5
    // (Threefold Veil, Piercing Wand, Wand Mastery). Everbloom/Clean Slate
    // are excluded here for the same reasoning as their sound handling in
    // main.js - Everbloom gets its flash from its own first tick instead
    // (can fire in this same broadcast, would double up), Clean Slate stays
    // silent/unflashed until it actually fires later.
    if (entry.characterId === 'marin' && !isKO('marin')) {
      // Threefold Veil's discovery gets its OWN dedicated image
      // (threefold_discovery.jpg - calm, eyes closed, the ward settling
      // into place) rather than reusing threefold.jpg (an active dodge in
      // motion) - both used to share one image, which made a discovery
      // announcement visually indistinguishable from a real dodge and led
      // directly to a live miscount report ("saw 4 dodges" when only 3
      // charges/real dodges had actually happened - one of the 4 was this
      // discovery flash).
      const MARIN_DISCOVERY_FLASH = {
        threefoldVeil: 'assets/images/marin/threefold_discovery.jpg',
        piercingWand: 'assets/images/marin/piercing_wand.jpg',
        wandMastery: 'assets/images/marin/wand_mastery.jpg',
      };
      const src = MARIN_DISCOVERY_FLASH[entry.spellId];
      if (src) setFlash('marin', src);
    }
    return;
  }
  if (entry.type === 'everbloom-tick') {
    // Recurring - re-fires every one of Marin's own turns for the rest of
    // the match once discovered, same "not just a one-shot cast flash"
    // shape as Rowan's Poison Cloud tile effect re-firing every damage
    // tick (see actionEffects.js's own poison-tick handling for the
    // client-side precedent this follows).
    if (entry.healed > 0 && !isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/marin/everbloom.jpg');
    return;
  }
  if (entry.type === 'clean-slate-trigger') {
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/marin/clean_slate.jpg');
    return;
  }
  if (entry.type === 'special' && entry.actionId === 'lifebond') {
    // Marin's Lifebond (taxonomy #34 Pool & Redistribute + #12 No Threat) -
    // flashes EVERY currently-living character's own lifebond.jpg at once,
    // Marin included (unlike Petrify's stone.jpg, which deliberately
    // excludes the caster - Lifebond genuinely affects Marin herself too,
    // she's just another "living character" in entry.changes, not exempt).
    // entry.changes (server's marin.js) is exactly the set of characters
    // this cast touched, one { characterId, before, after } per living
    // character - no separate isKO re-check needed for who to include, but
    // still guarded here in case a character somehow died in the same
    // broadcast batch between this cast and the flash actually rendering.
    for (const change of entry.changes || []) {
      if (!isKO(change.characterId)) {
        setFlash(change.characterId, `assets/images/${change.characterId}/lifebond.jpg`, LIFEBOND_FLASH_DURATION_MS);
      }
    }
    return;
  }
  if (entry.type === 'special' && entry.actionId === 'moonlitTheft') {
    // Velorya's Moonlit Theft (taxonomy #35 Siphon) - flashes shield_stolen.jpg
    // on every character entry.changes actually drained shield from (server's
    // velorya.js only includes characters who genuinely had shield > 0 at
    // cast time, which naturally means this only ever fires for the 5 heroes
    // who can have shield at all - Athena/Boingo/Tharox/Chronox/Melyssa -
    // confirmed ruling: "I think for hijack we only have to create image
    // those hero can have shield", so no art exists for anyone else and none
    // is needed, since they can never appear in this array to begin with.
    // Confirmed live bug, 2026-09-11: this block used to `return` here, same
    // as Lifebond's own handler above - but Lifebond's caster (Marin) IS
    // included in her own entry.changes (Lifebond affects her too), so her
    // flash fires from that same loop with no need for the generic switch
    // below. Velorya is NOT included in her own entry.changes here (she's
    // the thief, not a drained victim), so an early return here skipped the
    // generic switch entirely and her own moonlit_theft.jpg cast flash never
    // fired at all. Fixed by NOT returning - same fall-through pattern
    // Earthshatter/Shadow Seal's own multi-victim blocks already use, since
    // those two are in the identical situation (a caster who needs their own
    // separate cast-flash case further down, not included in their own
    // per-victim loop).
    for (const change of entry.changes || []) {
      if (!isKO(change.characterId)) {
        setFlash(change.characterId, `assets/images/${change.characterId}/shield_stolen.jpg`, MOONLIT_THEFT_FLASH_DURATION_MS);
      }
    }
    // Deliberately NOT returning here - falls through to the generic switch
    // below so Velorya's own 'assets/images/velorya/moonlit_theft.jpg' cast
    // flash (case 'moonlitTheft') still fires.
  }

  if (entry.type === 'special' && entry.actionId === 'earthshatter') {
    // Tharox's own cast flash still fires via the generic switch below (his
    // characterId is 'attack'/'special'-shaped like any other action) -
    // this block handles the per-victim strike art, read from entry.hits
    // (see tharox.js's own execute() - shape is { targetId, amountDealt,
    // koTriggered }, NOT targetCharacterId/dodged - Earthshatter always
    // sets ignoresDodge: true on every point, so there's no dodge concept
    // to check here at all). Replaces the old shared falling-stone
    // earthshatter_overlay.jpg (2026-09-15) with real per-victim art
    // (earthshatter_strike.jpg, one per hero, same pattern as
    // judgement_strike.jpg/doom_strike.jpg/ashka_strike.jpg/
    // shadow_strike.jpg) - each victim now shows THEIR OWN reaction
    // instead of a generic overlay layered on top of their portrait.
    // Deliberately NOT gated on !isKO(hit.targetId) - a hit that KO'd its
    // target should still show the strike art overriding the plain
    // koed.jpg for EARTHSHATTER_FLASH_DURATION_MS, same reasoning as every
    // other trigger flash in this file (confirmed explicit direction,
    // 2026-09-15: "animation should stay long, don't show koed image too
    // fast" - this WAS excluding KO'd victims entirely under the old
    // overlay mechanism, the exact opposite of every sibling flash's own
    // established rule, so this rebuild also fixes that inconsistency,
    // not just the art itself).
    for (const hit of entry.hits || []) {
      if (hit.amountDealt > 0) {
        setFlash(hit.targetId, `assets/images/${hit.targetId}/earthshatter_strike.jpg`, EARTHSHATTER_FLASH_DURATION_MS);
      }
    }
    // Deliberately NOT returning here - falls through to the generic
    // switch below so Tharox's own 'assets/images/tharox/final.jpg' cast
    // flash (case 'earthshatter') still fires exactly as before.
  }

  if (entry.type === 'special' && entry.actionId === 'shadowSeal') {
    // Akyros's own cast flash still fires via the generic switch below
    // (shadow_seal.jpg) - this block handles the per-victim reaction art,
    // read from entry.changes (see akyros.js's own shadowSeal execute() -
    // shape is { characterId, lockedHearts }, no amountDealt/dodged fields
    // at all since this deals no damage and bypasses applyDamage entirely).
    // Every OTHER living character gets their own shadow_seal_strike.jpg,
    // same per-victim-hero art pattern as judgement_strike.jpg/
    // doom_strike.jpg/ashka_strike.jpg. Gated on lockedHearts > 0 - a
    // character already at 0 hearts is impossible here (excluded via
    // !c.isKO in the server's own filter), so in practice this always
    // fires for every entry, but kept as an explicit "did this actually
    // apply" guard for consistency with every other trigger-flash gate.
    for (const change of entry.changes || []) {
      if (change.lockedHearts > 0) {
        setFlash(change.characterId, `assets/images/${change.characterId}/shadow_seal_strike.jpg`, SHADOW_SEAL_FLASH_DURATION_MS);
      }
    }
    // Deliberately NOT returning here - falls through to the generic
    // switch below so Akyros's own 'assets/images/akyros/shadow_seal.jpg'
    // cast flash (case 'shadowSeal') still fires exactly as before.
  }

  // Melyssa's Friendship (Redirect Bond) - ANY attack/special entry that
  // targeted her could have redirected to her friend instead
  // (damagePipeline.js's own applyDamage redirect hook stamps
  // redirectedToFriendId onto its result whenever this happens, spread
  // into the log entry the same way every other applyDamage field is).
  // Checked here, independent of actionId, since a redirect can happen on
  // literally any attack in the game, not just a fixed set of actions -
  // fires the protects_melyssa.jpg reaction on HER OWN tile (the friend
  // physically stepping in), completely separate from whatever flash the
  // ORIGINAL attacker's own action already triggers on their own tile via
  // the switch below.
  if (entry.redirectedToFriendId && !isKO('melyssa')) {
    setFlash('melyssa', `assets/images/${entry.redirectedToFriendId}/protects_melyssa.jpg`, PROTECTS_MELYSSA_FLASH_DURATION_MS);
  }

  if (entry.type !== 'attack' && entry.type !== 'special' && entry.type !== 'setup') return;
  const { characterId, actionId, dodged, amountDealt, targetCharacterId } = entry;
  if (isKO(characterId)) return;

  switch (actionId) {
    case 'friendship':
      setFlash(characterId, 'assets/images/melyssa/friendship.jpg', FRIENDSHIP_FLASH_DURATION_MS); break;
    case 'divineRestore':
      setFlash(characterId, 'assets/images/athena/heal.jpg'); break;
    case 'divineSacrifice':
      if (!dodged) setFlash(characterId, 'assets/images/athena/sacrifice.jpg');
      break;
    case 'divineJudgment':
      setFlash(characterId, 'assets/images/athena/judgment.jpg'); break;
    case 'glorySmash':
      setFlash(characterId, 'assets/images/tharox/glory.jpg');
      // Per-victim reaction art (confirmed direction, 2026-09-16: reuse the
      // same "heavy physical blow" concept across Smash/Titan Smash/Glory
      // Smash rather than Earthshatter's own ground-shattering art, which
      // is a different concept - same per-victim-hero art pattern as
      // judgement_strike.jpg/doom_strike.jpg/ashka_strike.jpg/
      // shadow_strike.jpg/earthshatter_strike.jpg). Gated on amountDealt>0
      // (not dodged) since Glory Smash always lands (no dodge concept for
      // it server-side) but could still be fully shield-absorbed.
      if (amountDealt > 0 && !isKO(targetCharacterId)) {
        setFlash(targetCharacterId, `assets/images/${targetCharacterId}/tharox_smash_strike.jpg`);
      }
      break;
    case 'earthshatter':
      setFlash(characterId, 'assets/images/tharox/final.jpg', EARTHSHATTER_FLASH_DURATION_MS); break;
    case 'titanToss':
      setFlash(characterId, 'assets/images/tharox/toss.jpg'); break;
    case 'smash': case 'titanSmash':
      if (!dodged) setFlash(characterId, 'assets/images/tharox/smash.jpg');
      // Same per-victim reaction art as Glory Smash above - gated on both
      // !dodged and amountDealt>0 since these two CAN be dodged (unlike
      // Glory Smash).
      if (!dodged && amountDealt > 0 && !isKO(targetCharacterId)) {
        setFlash(targetCharacterId, `assets/images/${targetCharacterId}/tharox_smash_strike.jpg`);
      }
      break;
    case 'soulSwap':
      setFlash(characterId, 'assets/images/zerathys/soul.jpg');
      // Per-victim reaction art (assets/images/<id>/soul_drain.jpg, 15 new
      // images, added 2026-09-25) - always fires, Soul Swap has no dodge
      // mechanic of its own (it directly exchanges hearts, not routed
      // through applyDamage at all). Replaces the old generic
      // 'invertflash' client-side effect (actionEffects.js), removed in
      // the same pass - confirmed ruling: "we will remove the current
      // animation of souls swap effect. becasue image is engouh."
      // Confirmed real bug, 2026-09-25 (live report: "soul drain animation
      // not playing"): this used targetCharacterId (the destructured field
      // at the top of this function), but Soul Swap's own log entry
      // (zerathys.js) only ever sets targetId, never targetCharacterId -
      // so the guard always failed silently. Fixed to read entry.targetId
      // directly, same pattern Self Choke/Friendship/Ashka's Vengeance's
      // own victim flashes already use for this exact log-entry shape.
      if (entry.targetId) {
        setFlash(entry.targetId, `assets/images/${entry.targetId}/soul_drain.jpg`, SOUL_DRAIN_FLASH_DURATION_MS);
      }
      break;
    case 'chargeUp':
      setFlash(characterId, 'assets/images/zerathys/charge.jpg'); break;
    case 'thunderWrath': case 'soulSwapWrath':
      // Overcharge Collapse (hearts<=3): a distinct, more intense strike
      // image for the moment he's both dealing the guaranteed 3 damage AND
      // gaining his own shield stake from it at once (confirmed ruling,
      // 2026-09-11: "he is damaging 3 . and also gaining shield.. in one
      // image. during overcharge state") - entry.overcharged is stamped by
      // this same executeThunderWrath call (zerathys.js) that grants the
      // shield, so the two are always in sync by construction.
      if (!dodged) {
        setFlash(characterId, entry.overcharged
          ? 'assets/images/zerathys/overcharge_strike.jpg'
          : 'assets/images/zerathys/strike.jpg');
      }
      break;
    case 'timeFreeze':
      setFlash(characterId, 'assets/images/chronox/time.jpg'); break;
    case 'worldStops':
      setFlash(characterId, 'assets/images/chronox/world_stop.jpg', WORLD_STOPS_FLASH_DURATION_MS); break;
    case 'rewind':
      setFlash(characterId, 'assets/images/chronox/rewind.jpg'); break;
    case 'cyclonePunch':
      if (!dodged) setFlash(characterId, 'assets/images/chronox/cyclone.jpg');
      break;
    case 'shadowExecution':
      if (!dodged) setFlash(characterId, 'assets/images/akyros/shadow.jpg');
      break;
    case 'fatalSlash':
      if (!dodged) setFlash(characterId, 'assets/images/akyros/fatal.jpg');
      break;
    case 'shadowToll':
      // Threshold Shift (#38) - self-only, no victims, default flash
      // duration (not the longer multi-beat SHADOW_SEAL_FLASH_DURATION_MS
      // - this is a quiet single-character moment, not a dramatic
      // multi-victim beat).
      setFlash(characterId, 'assets/images/akyros/shadow_toll.jpg'); break;
    case 'shadowSeal':
      setFlash(characterId, 'assets/images/akyros/shadow_seal.jpg', SHADOW_SEAL_FLASH_DURATION_MS); break;
    case 'lunarEclipse':
      setFlash(characterId, 'assets/images/velorya/casting.jpg'); break;
    case 'moonlitTheft':
      setFlash(characterId, 'assets/images/velorya/moonlit_theft.jpg', MOONLIT_THEFT_FLASH_DURATION_MS); break;
    case 'lunarStrike': case 'moonstep':
      if (!dodged) setFlash(characterId, 'assets/images/velorya/strike.jpg');
      break;
    case 'bloodHunt':
      if (!dodged) setFlash(characterId, 'assets/images/blade/strike.jpg');
      break;
    case 'bloodFrenzy':
      setFlash(characterId, 'assets/images/blade/blood_frenzy.jpg', BLOOD_FRENZY_FLASH_DURATION_MS); break;
    case 'grudgeStrike':
      if (!dodged) setFlash(characterId, 'assets/images/kaelis/grudge.jpg');
      break;
    case 'callAshka':
      setFlash(characterId, 'assets/images/kaelis/bird.jpg'); break;
    case 'dyingBlow':
      // Bonus-turn strikes (during his Deathless Fury payoff) flash a
      // distinct immortal_strike image, layered on top of his persistent
      // immortality.jpg portrait (getPersistentPortrait above) - a normal
      // turn's single strike flashes normal_strike instead. Both share
      // this one actionId/execute(), so the distinction has to come from
      // the log entry's own isBonusStrike flag (draxus.js), not the
      // action id itself.
      //
      // Resurrection Gamble (Cheat Death, taxonomy #32) - EVERY strike for
      // the rest of the match after a successful revival also flashes
      // immortal_strike.jpg, not just genuine Deathless Fury bonus strikes
      // (confirmed ruling: "for every strike immortal strike image will
      // play" - "he was koed. and alived again"). hasRevivedOnce is sticky
      // (never clears), matching alive.jpg's own persistent-portrait
      // lifetime above.
      if (!dodged) {
        const usesImmortalStrike = entry.isBonusStrike || game.characters.draxus?.special?.hasRevivedOnce;
        setFlash(characterId, usesImmortalStrike ? 'assets/images/draxus/immortal_strike.jpg' : 'assets/images/draxus/normal_strike.jpg');
      }
      break;
    case 'deathlessFury':
      // Cast-moment flash briefly reinforces the same image the
      // persistent override (getPersistentPortrait) then holds.
      setFlash(characterId, 'assets/images/draxus/immortality.jpg'); break;
    case 'chaosGamble':
      // 'lose' always flashes the miss portrait regardless of dodged (a
      // 0-damage roll can still report dodged:true against Akyros's first
      // hit) - matches the main game, which has no dodge guard on this
      // branch. 'win'/'draw' stay dodge-gated since those rolls deal real
      // damage that Akyros can actually dodge.
      if (entry.outcome === 'lose') setFlash(characterId, 'assets/images/boingo/miss.jpg');
      else if (!dodged) {
        if (entry.outcome === 'win') setFlash(characterId, 'assets/images/boingo/hardpunch.jpg');
        else if (entry.outcome === 'draw') setFlash(characterId, 'assets/images/boingo/normalpunch.jpg');
      }
      break;
    case 'fowlPlay':
      setFlash(characterId, 'assets/images/boingo/foul_play.jpg', FOWL_PLAY_FLASH_DURATION_MS); break;
    case 'chickenAttack':
      if (!dodged) {
        // Per-hero chicken art (2026-09-04) - the attacker here is always
        // a chickenified character (Chicken Attack is their only legal
        // action), so its own hero-specific chicken_attack.jpg applies.
        setFlash(characterId, chickenImagePath(characterId, '_attack.jpg'));
        // Distinct victim-side reaction flash (with its own egg-drop gag),
        // separate from the attacker's own chicken_attack.jpg above -
        // confirmed ruling: fires on ANY chicken taking damage, a brief
        // flash rather than a persistent injured-state portrait. amountDealt
        // > 0 gate matches every other victim reaction in this file (a
        // dodged/0-damage hit shows no reaction). Boingo himself CAN be the
        // target here (chickens are allowed to attack him) but he's never
        // chickenified, so he keeps his own normal hit reaction instead -
        // this flash is only for a genuinely chickenified target, using
        // THAT target's own hero-specific chicken_hit.jpg.
        if (amountDealt > 0 && targetCharacterId && !isKO(targetCharacterId)
          && game.characters[targetCharacterId]?.isChicken) {
          setFlash(targetCharacterId, chickenImagePath(targetCharacterId, '_hit.jpg'));
        }
      }
      break;
    case 'wandStrike':
      // Shared action id (Rowan and Marin both have a Wand Strike) - the
      // image folder differs per character, everything else about the
      // trigger condition is identical.
      if (!dodged) {
        setFlash(characterId, characterId === 'marin' ? 'assets/images/marin/wand_strike.jpg' : 'assets/images/rowan/wand_strike.jpg');
      }
      break;
    case 'arcaneStudy':
      // Same shared-action-id reasoning as wandStrike above.
      setFlash(characterId, characterId === 'marin' ? 'assets/images/marin/arcane_study.jpg' : 'assets/images/rowan/arcane_study.jpg');
      break;
    case 'poisonCloud':
      setFlash(characterId, 'assets/images/rowan/poison_cloud.jpg'); break;
    case 'purify':
      setFlash(characterId, 'assets/images/rowan/purify.jpg'); break;
    case 'wildLightning':
      if (!dodged) setFlash(characterId, 'assets/images/rowan/wild_lightning.jpg');
      break;
    case 'mirrorReflect':
      setFlash(characterId, 'assets/images/rowan/mirror_reflect.jpg'); break;
    case 'silenceLock':
      setFlash(characterId, 'assets/images/rowan/silence_lock.jpg'); break;
    case 'frogCurse':
      setFlash(characterId, 'assets/images/rowan/frog_curse.jpg'); break;
    case 'snakeStrike':
      // Rowan's own attack flash, plus a dedicated per-victim reaction
      // (assets/images/<id>/snake_bite.jpg, 15 new images - distinct from
      // both frog.jpg's idle pose and frog_dodge.jpg's evasion pose).
      // Unlike a normal attack (which only gets the generic 'hit'/'claw'
      // shake effect on the victim, no dedicated portrait swap - see
      // Skull Crack's own identical case just above for the precedent this
      // diverges from), Snake Strike always connects (ignoresDodge: true
      // server-side, so `dodged` here is always false in practice) and the
      // curse always ends as a direct result - a genuinely distinctive
      // enough moment to warrant its own per-hero art, same reasoning as
      // Ashka's Vengeance/Divine Judgment's own per-victim trigger art.
      setFlash(characterId, 'assets/images/rowan/snake_strike.jpg');
      // Deliberately NOT gated on !isKO(targetCharacterId), unlike most
      // other victim flashes in this file - confirmed real bug, 2026-09-24
      // (live report: "snake bite animation will not stop if suddenly
      // koed. don't show koed image quickly"). By the time this entry
      // dispatches, the broadcast state already reflects the post-hit
      // isKO=true if the strike was lethal, so the original !isKO guard
      // suppressed the snake_bite.jpg reaction entirely on a killing blow -
      // the exact case where the reaction matters most. Same "deliberately
      // NOT gated on the usual !isKO guard" shape as Divine Judgment's own
      // per-victim trigger art (portraitFlash.js's judgement_strike.jpg
      // case) - the victim genuinely IS KO'd by the time this fires, that's
      // expected, not a reason to skip the reaction.
      if (targetCharacterId) {
        setFlash(targetCharacterId, `assets/images/${targetCharacterId}/snake_bite.jpg`);
      }
      break;
    case 'petrify':
      // The "everyone else turns to stone" effect itself is handled by
      // petrifyActive above (persistent state, not a timed flash) - this
      // case only fires Rowan's own cast flash on his own tile, same
      // FLASH_DURATION_MS as any normal cast.
      setFlash(characterId, 'assets/images/rowan/petrify.jpg'); break;
    case 'grimStrike':
      if (!dodged) setFlash(characterId, 'assets/images/grimtal/normal_attack.jpg');
      break;
    case 'skullCrack':
      if (!dodged) setFlash(characterId, 'assets/images/grimtal/skull_crack.jpg');
      break;
    case 'claimKill':
      setFlash(characterId, 'assets/images/grimtal/claim_kill.jpg'); break;
    case 'beastForm':
      // The persistent transformed portrait itself is handled by
      // getPersistentPortrait's own beastFormActive check above (real
      // state, not a timed flash, since the effect has no fixed duration) -
      // this case only fires a brief cast-moment flash, same "cast flash
      // AND persistent state, not either/or" pattern Rowan's Petrify
      // already establishes just above. Uses a distinct mid-transformation
      // image (beast_start.jpg) rather than the persistent already-
      // transformed beast.jpg, mirroring beast_end.jpg's reversion flash.
      setFlash(characterId, 'assets/images/grimtal/beast_start.jpg'); break;
    case 'beastAttack':
      if (!dodged) {
        setFlash(characterId, 'assets/images/grimtal/beast_attack.jpg');
        // Per-victim reaction (assets/images/<id>/beast_mauled.jpg, 15 new
        // images) - only on an actual landed hit, unlike Snake Strike which
        // always connects; a dodge already shows the victim's own normal
        // dodge reaction via handleDodgeForFlash, so this only needs the
        // positive "hit landed" case. Deliberately NOT gated on !isKO,
        // same reasoning as snakeStrike's own victim flash just above -
        // the reaction should still show even on a killing blow.
        if (targetCharacterId) {
          setFlash(targetCharacterId, `assets/images/${targetCharacterId}/beast_mauled.jpg`);
        }
      }
      break;
    case 'mirageMark':
      setFlash(characterId, 'assets/images/illyra/mirage_mark.jpg'); break;
    case 'mirageBurst':
      // Always flashes on cast, regardless of amountDealt - unlike a
      // normal attack, this can never be dodged (ignoresDodge: true is
      // always set server-side), so the detonation itself always visibly
      // happens even if the target's shield ends up absorbing all of it.
      setFlash(characterId, 'assets/images/illyra/mirage_burst.jpg'); break;
    case 'mirageOverload':
      setFlash(characterId, 'assets/images/illyra/mirage_overload.jpg'); break;
    case 'runeStrike':
      // Empowered (3 damage, both prediction wins banked) gets its own
      // more intense flash image, same amountDealt-gated swap the sound/
      // voice already do (see main.js).
      if (!dodged) {
        setFlash(characterId, amountDealt >= 3 ? 'assets/images/oraclus/rune_strong_strike.jpg' : 'assets/images/oraclus/rune_strike.jpg');
        // Per-victim reaction art (assets/images/<id>/rune_strike_hit.jpg,
        // 15 new images, added 2026-09-25) - one shared image for both the
        // normal and empowered tier (confirmed scope: single 15-hero set,
        // not two). Uses targetCharacterId (correctly present here since
        // runeStrike's own log entry spreads applyDamage's result object,
        // unlike Soul Swap's own bypass-applyDamage shape which only ever
        // sets targetId - see that earlier confirmed bug's fix for the
        // contrast).
        if (targetCharacterId) {
          setFlash(targetCharacterId, `assets/images/${targetCharacterId}/rune_strike_hit.jpg`);
        }
      }
      break;
    case 'runeVision':
      // Fires on stage 1 (the cast) only - stage 2 (entry.stage === 2,
      // picking the predicted target) is a plain data completion of the
      // same cast, not a second visible moment worth re-flashing.
      if (entry.stage === 1) setFlash(characterId, 'assets/images/oraclus/rune_prediction.jpg');
      break;
    case 'prophecyOfDoom':
      setFlash(characterId, 'assets/images/oraclus/prophecy.jpg'); break;
    default:
      break;
  }
}

// 'dodge' is its own log entry type (see damagePipeline.js), keyed on the
// DEFENDER, not the actor - handled separately from the switch above.
export function handleDodgeForFlash(entry, game) {
  if (entry.type !== 'dodge') return;
  const target = game.characters[entry.targetCharacterId];
  if (!target || target.isKO) return;
  // Rowan's Frog Curse - checked via isFrog directly, not a fixed
  // target.id like Marin/Grimtal/Illyra below, since the frog can be any
  // of the 15 non-Rowan heroes dynamically. isFrog stays true through a
  // SUCCESSFUL dodge (only a connecting hit clears it in
  // damagePipeline.js), so this correctly distinguishes "this was Frog
  // Curse's own dodge" from every other hero's own dodge mechanic. Unlike
  // the shared generic dodge sound/voice (main.js), the FLASH is per-victim
  // hero (assets/images/<id>/frog_dodge.jpg, 15 new images) so each
  // character's own jump-away pose stays visually consistent with their
  // design, same "per-hero art, shared audio" split already used
  // elsewhere (e.g. chicken art vs. its shared sound set).
  if (target.isFrog) {
    setFlash(target.id, `assets/images/${target.id}/frog_dodge.jpg`);
    return;
  }
  // Shared log entry type/shape (damagePipeline.js's applyDamage pushes the
  // same 'dodge' entry for Akyros's per-attacker dodge, Marin's Threefold
  // Veil flat 3-charge pool, Grimtal's Grim Ward, AND Illyra's passive) -
  // the image differs per character, same reasoning as wandStrike/
  // arcaneStudy's shared-action-id branching below in this file.
  const src = target.id === 'marin' ? 'assets/images/marin/threefold.jpg'
    : target.id === 'grimtal' ? 'assets/images/grimtal/dodge.jpg'
    : target.id === 'illyra' ? 'assets/images/illyra/illusion.jpg'
    : 'assets/images/akyros/dodge.jpg';
  setFlash(target.id, src);
}
