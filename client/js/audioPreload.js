// Warms the browser's HTTP cache for every sound effect, music track, and
// character voice line up front - same reasoning as imagePreload.js for
// battle images: without this, the very first time a given effect/voice
// is needed mid-match, playing it has to wait on a live network fetch
// before any sound comes out, which reads as audio being slow/delayed the
// first time (exactly the same class of bug the image preload fixed for
// portraits).
import { allVoiceFilePaths } from './voice.js';

// Every file under assets/sounds/ - listed explicitly (not derived from
// sound.js's ACTION_SOUND map, which only covers ability-triggered sounds
// and misses music tracks, click/dodge/victory/etc.) since this list
// changes rarely, unlike voice lines which are actively being added
// character-by-character - keep this in sync with assets/sounds/ if a new
// effect or music track is ever added.
const SOUND_EFFECT_FILES = [
  'bgm-battle.mp3', 'bgm-battle-2.mp3', 'bgm-battle-3.mp3',
  'bgm-menu.mp3', 'bgm-menu-2.mp3', 'bgm-menu-3.mp3',
  'charge.mp3', 'click.mp3', 'coin.mp3', 'curse.mp3', 'cyclonepunch.mp3',
  'divinerestore.mp3', 'dodge.mp3', 'eclipse.mp3', 'freeze.mp3',
  'game-over.mp3', 'hiddenmark.mp3', 'jesterball.mp3', 'kick.mp3',
  'magic.mp3', 'miss.mp3', 'moonstep.mp3', 'punch.mp3', 'rebirth.mp3',
  'shadowexecution.mp3', 'smash.mp3', 'soulswap.mp3',
  'sword.mp3', 'thunder.mp3', 'toss.mp3', 'victory.mp3',
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
    audio.src = path;
  }
}
