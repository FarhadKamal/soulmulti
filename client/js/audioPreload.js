// Warms the browser's HTTP cache for every sound effect, music track, and
// character voice line up front - same reasoning as imagePreload.js for
// battle images: without this, the very first time a given effect/voice
// is needed mid-match, playing it has to wait on a live network fetch
// before any sound comes out, which reads as audio being slow/delayed the
// first time (exactly the same class of bug the image preload fixed for
// portraits).
import { allVoiceFilePaths } from './voice.js';
import { v } from './assetVersion.js';

// Every one-shot sound effect under assets/sounds/ - listed explicitly (not
// derived from sound.js's ACTION_SOUND map, which only covers ability-
// triggered sounds and misses click/dodge/victory/etc.) since this list
// changes rarely, unlike voice lines which are actively being added
// character-by-character - keep this in sync with assets/sounds/ if a new
// effect is ever added.
//
// Deliberately excludes the 6 bgm-*.mp3 music tracks (~26MB total) - each
// startMenuMusic()/startBattleMusic() call randomly picks ONE track and
// fetches it directly via its own new Audio()+play(), so preloading all 6
// here just downloaded ~20MB of music that would never be heard in that
// session, on every single fresh page load. That was the single largest
// contributor to blowing through Render's free-tier bandwidth cap.
// startMenuMusic() already fires immediately at page load (see main.js),
// so there was never a meaningful "first play is slow" gap for music to
// begin with - unlike the short action-sound effects below, where that
// gap is real and worth avoiding.
const SOUND_EFFECT_FILES = [
  'charge.mp3', 'click.mp3', 'coin.mp3', 'curse.mp3', 'cyclonepunch.mp3',
  'divinerestore.mp3', 'dodge.mp3', 'eclipse.mp3', 'explosion.mp3', 'freeze.mp3',
  'game-over.mp3', 'hiddenmark.mp3', 'jesterball.mp3', 'kick.mp3',
  'magic.mp3', 'miss.mp3', 'moonstep.mp3', 'punch.mp3', 'rebirth.mp3',
  'shadowexecution.mp3', 'smash.mp3', 'soulswap.mp3',
  'sword.mp3', 'thunder.mp3', 'toss.mp3', 'victory.mp3',
  'mind_control.mp3', 'self_choke.mp3',
  'grudge_hit.mp3', 'bird_heal.mp3',
  'axe_strike.mp3', 'deathless_fury.mp3',
  'wand_strike.mp3', 'study.mp3', 'cloud.mp3', 'healing.mp3', 'lightning.mp3', 'mirror.mp3', 'lock.mp3',
  'everbloom.wav', 'magic_dodge.wav', 'silent_study.wav', 'cleanSlate.mp3', 'wand_discover.mp3',
  'sword_thud.mp3', 'bullet_hit.mp3', 'head_spin.mp3',
  'illusion.mp3', 'mirage_mark.mp3', 'mirage_burst.mp3',
];

let started = false;

export function preloadBattleAudio() {
  if (started) return;
  started = true;
  const paths = [
    ...SOUND_EFFECT_FILES.map((f) => `assets/sounds/${f}`),
    ...allVoiceFilePaths(),
  ];
  // Plain Audio() objects, never played or attached to the DOM - setting
  // .src alone is enough to make the browser fetch and cache the file, the
  // same trick imagePreload.js uses with new Image(). No onload/onerror
  // handling needed - a failed/missing file here just means that one
  // sound falls back to its normal (slower) first-use fetch, same as
  // before this file existed.
  for (const path of paths) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = v(path);
  }
}
