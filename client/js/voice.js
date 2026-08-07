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
const cache = {};

function get(characterId, line) {
  const key = `${characterId}/${line}`;
  if (!cache[key]) {
    cache[key] = new Audio(`assets/voice/${characterId}/${line}.mp3`);
  }
  return cache[key];
}

function playVoiceFile(characterId, line) {
  try {
    const base = get(characterId, line);
    const node = base.cloneNode();
    node.volume = 0.85;
    node.play().catch(() => {});
  } catch {
    // ignore - missing/blocked file, same silent-fallback policy as
    // sound.js's playSound
  }
}

// Per-character filenames, exactly as recorded (see assets/voice/<id>/) -
// deliberately NOT a uniform naming scheme (e.g. boingo's throw line is
// "jerster.mp3", athena's special is "devine.mp3") since these were named
// ad hoc per recording session; this table is the single place that maps
// the game's own concepts (idle/injured/koed/victory/signature move) onto
// whatever the actual filename ended up being.
const VOICE_LINES = {
  chronox: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory', move: 'time_freeze' },
  velorya: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory', move: 'eclipse' },
  boingo: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory', move: 'jerster', laugh: 'HAHAHAHA' },
  athena: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory', move: 'devine' },
  zerathys: { idle: 'idle', injured: 'injured', koed: 'koed', victory: 'victory', move: 'soul_swap' },
};

// The one actionId per character whose cast/throw/etc. triggers that
// character's 'move' voice line (Chronox's Time Freeze, Velorya's Lunar
// Eclipse, Boingo's Jester Ball throw, Athena's Divine Restore) - kept
// separate from VOICE_LINES itself since it's a different KIND of key
// (actionId, not a fixed category) and only one signature move exists per
// character so far.
const SIGNATURE_MOVE_ACTION_ID = {
  chronox: 'timeFreeze',
  velorya: 'lunarEclipse',
  boingo: 'jesterBall',
  athena: 'divineRestore',
  zerathys: 'soulSwap',
};

export function hasVoice(characterId) {
  return !!VOICE_LINES[characterId];
}

export function playIdleVoice(characterId) {
  const line = VOICE_LINES[characterId]?.idle;
  if (line) playVoiceFile(characterId, line);
}

export function playInjuredVoice(characterId) {
  const line = VOICE_LINES[characterId]?.injured;
  if (line) playVoiceFile(characterId, line);
}

// Returns true if a voice line actually played - callers use this to
// decide whether to ALSO play the generic koed/victory sound (see
// main.js): a recorded character's own voice REPLACES the generic sound
// for that moment; an unrecorded character still gets the generic one.
export function playKoedVoice(characterId) {
  const line = VOICE_LINES[characterId]?.koed;
  if (!line) return false;
  playVoiceFile(characterId, line);
  return true;
}

export function playVictoryVoice(characterId) {
  const line = VOICE_LINES[characterId]?.victory;
  if (!line) return false;
  playVoiceFile(characterId, line);
  return true;
}

// Plays alongside the move's existing sound effect (playActionSound in
// sound.js), never replacing it - the effect gives the action its punch,
// the voice adds character on top.
export function playMoveVoice(characterId, actionId) {
  if (SIGNATURE_MOVE_ACTION_ID[characterId] !== actionId) return;
  const line = VOICE_LINES[characterId]?.move;
  if (line) playVoiceFile(characterId, line);
}

// Boingo's cackle when the Jester Ball returns to him (see main.js's
// 'jester-ball-return' handler) - plays alongside the existing 'magic'
// return sound effect, same layering as playMoveVoice above. Only Boingo
// has a 'laugh' line so far; a no-op for anyone else.
export function playLaughVoice(characterId) {
  const line = VOICE_LINES[characterId]?.laugh;
  if (line) playVoiceFile(characterId, line);
}
