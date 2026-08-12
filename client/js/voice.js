// Character voice lines - a third, independent audio layer alongside
// background music (sound.js's startMenuMusic/startBattleMusic) and sound
// effects (sound.js's playSound/playActionSound). All three can play at
// once: each is its own Audio element (or a cloneNode() per call, for
// effects/voice that can overlap themselves), and browsers play multiple
// concurrent Audio elements natively - no mixing/ducking logic needed.
//
// Only characters with a recorded voice set exist in VOICE_CHARACTERS
// below - every lookup function returns false/no-ops for any other
// character id, so characters without recordings yet fall back to
// whatever generic sound already played for that moment (see main.js's
// call sites), rather than erroring on a missing file.
import { v } from './assetVersion.js';

const cache = {};

function get(characterId, line) {
  const key = `${characterId}/${line}`;
  if (!cache[key]) {
    cache[key] = new Audio(v(`assets/voice/${characterId}/${line}.mp3`));
  }
  return cache[key];
}

// The currently-playing voice clip (if any) - tracked so a higher-priority
// arrival within the arbitration window can actively cut it off rather
// than letting two human voices overlap even briefly (see
// ARBITRATION_WINDOW_MS below for why this matters: koed can legitimately
// fire ~200ms after a move-voice from the same broadcast already started
// playing).
let currentClip = null;

function playRawVoiceFile(characterId, line) {
  try {
    if (currentClip) {
      currentClip.pause();
      currentClip = null;
    }
    const base = get(characterId, line);
    const node = base.cloneNode();
    node.volume = 0.85;
    node.addEventListener('ended', () => { if (currentClip === node) currentClip = null; });
    // Set currentClip BEFORE play() resolves, not inside a .then() - a
    // second call arriving synchronously right after this one (which is
    // exactly the scenario this whole cutoff mechanism exists for) would
    // otherwise still see currentClip as null and fail to cut this one
    // off, since play()'s returned promise only resolves on a later
    // microtask, after the synchronous call stack of both calls has
    // already finished.
    currentClip = node;
    node.play().catch(() => {});
  } catch {
    // ignore - missing/blocked file, same silent-fallback policy as
    // sound.js's playSound
  }
}

// Priority arbitration: multiple voice categories can genuinely fire from
// the SAME server broadcast (e.g. Zerathys's Thunder Wrath landing is, in
// one broadcast: his own 'release' move-voice, the victim's 'injured'
// voice if that hit dropped them below half, AND the next character's
// 'idle' voice if turn order rotated straight to someone untouched) -
// several human voices talking over each other reads as broken, unlike
// sound effects/music which are short and layer fine. Only the single
// highest-priority voice within a short rolling window actually plays;
// everything else in that window is dropped, not queued or delayed.
//
// koed/rebirth are the biggest, rarest moments (a character dying or
// clawing back from death) - never drowned out by anything. victory sits
// below those two but above everything else the winning side might also
// trigger in the same instant (e.g. a move voice on the killing blow).
// idle is the most common, lowest-stakes trigger (just "still healthy at
// turn start") - loses to literally everything.
const PRIORITY = { koed: 6, rebirth: 5, victory: 4, move: 3, laugh: 2, injured: 1, idle: 0 };
// KO'd voices fire via a 200ms setTimeout in main.js (see playKoedFor)
// rather than synchronously with the triggering action's own move-voice
// call - the window has to be comfortably longer than that stagger, or a
// same-broadcast koed would arrive just after the window closed and
// wrongly play alongside whatever move-voice already claimed the slot.
const ARBITRATION_WINDOW_MS = 300;
let windowStartedAt = 0;
let windowWinnerPriority = -1;

function playVoiceFile(characterId, line, priority) {
  const now = Date.now();
  if (now - windowStartedAt > ARBITRATION_WINDOW_MS) {
    // Previous window has fully elapsed - this is a genuinely new moment,
    // starts its own fresh window regardless of priority.
    windowStartedAt = now;
    windowWinnerPriority = priority;
  } else if (priority >= windowWinnerPriority) {
    // Still within an active window, but this one outranks (or ties) the
    // current winner - it preempts. Actively cuts off whatever's currently
    // playing (see currentClip/playRawVoiceFile above) rather than letting
    // both voices overlap even briefly, and its own priority becomes the
    // new bar every later arrival in the window must clear.
    windowWinnerPriority = priority;
  } else {
    return; // outranked by something already claimed in this window - drop it
  }
  playRawVoiceFile(characterId, line);
}

// Per-character filenames, exactly as recorded (see assets/voice/<id>/) -
// deliberately NOT a uniform naming scheme (e.g. boingo's throw line is
// "jerster.mp3", athena's special is "devine.mp3") since these were named
// ad hoc per recording session; this table is the single place that maps
// the game's own concepts (idle/injured/koed/victory) onto whatever the
// actual filename ended up being. Per-action lines (signature moves) live
// in ACTION_VOICE_LINES below instead, since a character can have more
// than one (Zerathys has 3: Charge Up, Thunder Wrath, Soul Swap).
const VOICE_LINES = {
  chronox: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory' },
  velorya: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory' },
  boingo: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory', laugh: 'HAHAHAHA' },
  athena: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory' },
  zerathys: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory' },
  // rebirth: not part of ACTION_VOICE_LINES below - Rebirth isn't a
  // player-picked action with its own actionId, it's an automatic
  // KO-intercept inside applyDamage (see playRebirthVoice further down).
  blade: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory', rebirth: 'rebirth' },
  tharox: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory' },
  // "injued" is a real typo in the recorded filename, not a bug here -
  // matches assets/voice/akyros/ exactly as it exists on disk.
  akyros: { idle: 'idle', injured: 'injued', koed: 'koed', victory: 'victory' },
  melyssa: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory' },
};

// actionId -> filename, per character - every action here plays its line
// alongside that move's existing sound effect (playMoveVoice below), never
// replacing it. Most characters have exactly one signature move; Zerathys
// has three (his charge/release pair plus Soul Swap), Tharox now has three
// too (titanToss - the wind-up before titanSmash - added alongside his
// existing titanSmash/glorySmash lines), Akyros has two.
const ACTION_VOICE_LINES = {
  chronox: { timeFreeze: 'time_freeze' },
  velorya: { lunarEclipse: 'eclipse' },
  boingo: { jesterBall: 'jerster' },
  athena: { divineRestore: 'devine' },
  zerathys: { chargeUp: 'charge', thunderWrath: 'release', soulSwap: 'soul_swap' },
  tharox: { titanToss: 'titan_toss', titanSmash: 'titan_smash', glorySmash: 'glory' },
  akyros: { hiddenMark: 'hidden_mark', shadowExecution: 'shadow' },
  // mindControl's line fires from main.js's dedicated 'mind-control-select'
  // sound branch (via playMoveVoice(entry.characterId, 'mindControl')), not
  // the generic bottom-of-switch call every other actionId uses - selection
  // is its own log entry type, not 'attack'/'special'/'setup'. selfChoke
  // needs no special-casing anywhere: its log entry IS a normal
  // type: 'attack' with actionId: 'selfChoke', so it flows through the
  // existing generic playMoveVoice call automatically.
  melyssa: { mindControl: 'mind_control', selfChoke: 'self_choke' },
};

export function hasVoice(characterId) {
  return !!VOICE_LINES[characterId];
}

export function playIdleVoice(characterId) {
  const line = VOICE_LINES[characterId]?.idle;
  if (line) playVoiceFile(characterId, line, PRIORITY.idle);
}

export function playInjuredVoice(characterId) {
  const line = VOICE_LINES[characterId]?.injured;
  if (line) playVoiceFile(characterId, line, PRIORITY.injured);
}

// Returns true if a voice LINE EXISTS for this character (not whether it
// actually won arbitration and played) - callers use this to decide
// whether to ALSO play the generic koed/victory sound: a recorded
// character's own voice REPLACES the generic sound for that moment; an
// unrecorded character still gets the generic one. koed is the top
// priority so in practice it always wins arbitration when it exists, but
// the return value intentionally reflects "do we own this moment" (skip
// the generic sound) rather than "did audio literally start," which
// would incorrectly re-add the generic sound on the rare case this loses
// to something already claimed in the window.
export function playKoedVoice(characterId) {
  const line = VOICE_LINES[characterId]?.koed;
  if (!line) return false;
  playVoiceFile(characterId, line, PRIORITY.koed);
  return true;
}

export function playVictoryVoice(characterId) {
  const line = VOICE_LINES[characterId]?.victory;
  if (!line) return false;
  playVoiceFile(characterId, line, PRIORITY.victory);
  return true;
}

// Plays alongside the move's existing sound effect (playActionSound in
// sound.js), never replacing it - the effect gives the action its punch,
// the voice adds character on top. A no-op for any action without its own
// recorded line (see ACTION_VOICE_LINES above).
export function playMoveVoice(characterId, actionId) {
  const line = ACTION_VOICE_LINES[characterId]?.[actionId];
  if (line) playVoiceFile(characterId, line, PRIORITY.move);
}

// Boingo's cackle when the Jester Ball returns to him (see main.js's
// 'jester-ball-return' handler) - plays alongside the existing 'magic'
// return sound effect, same layering as playMoveVoice above. Only Boingo
// has a 'laugh' line so far; a no-op for anyone else.
export function playLaughVoice(characterId) {
  const line = VOICE_LINES[characterId]?.laugh;
  if (line) playVoiceFile(characterId, line, PRIORITY.laugh);
}

// Blade's line the moment Rebirth fires (see main.js's dedicated
// 'rebirth' log-entry handler) - plays alongside the existing generic
// rebirth sound effect (sound.js's playRebirth), never replacing it. Only
// Blade has a 'rebirth' line (he's the only character with the ability);
// a no-op for anyone else.
export function playRebirthVoice(characterId) {
  const line = VOICE_LINES[characterId]?.rebirth;
  if (line) playVoiceFile(characterId, line, PRIORITY.rebirth);
}

// Every recorded voice file's path, derived from VOICE_LINES/
// ACTION_VOICE_LINES themselves rather than a separately maintained list -
// used by voicePreload.js to warm the cache for all of them up front. New
// lines added to either table above are automatically included here too,
// so there's nothing else to keep in sync when a new voice is recorded.
export function allVoiceFilePaths() {
  const paths = [];
  for (const [characterId, lines] of Object.entries(VOICE_LINES)) {
    for (const filename of Object.values(lines)) paths.push(`assets/voice/${characterId}/${filename}.mp3`);
  }
  for (const [characterId, actions] of Object.entries(ACTION_VOICE_LINES)) {
    for (const filename of Object.values(actions)) paths.push(`assets/voice/${characterId}/${filename}.mp3`);
  }
  return paths;
}
