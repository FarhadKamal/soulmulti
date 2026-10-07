// Warms the browser's HTTP cache for every sound effect, music track, and
// character voice line up front - same reasoning as imagePreload.js for
// battle images: without this, the very first time a given effect/voice
// is needed mid-match, playing it has to wait on a live network fetch
// before any sound comes out, which reads as audio being slow/delayed the
// first time (exactly the same class of bug the image preload fixed for
// portraits).
import { allVoiceFilePaths } from './voice.js';
import { v } from './assetVersion.js';

// Every one-shot sound effect under assets/sounds/<hero>/ (and common/ for
// the few no single hero owns - split per hero 2026-10-07; a sound shared
// by several heroes has its own copy in each) - listed explicitly (not
// derived from sound.js's ACTION_SOUND map, which only covers ability-
// triggered sounds and misses click/dodge/victory/etc.) since this list
// changes rarely - keep this in sync with assets/sounds/ if a new effect
// is ever added.
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
  'common/click.mp3', 'common/dodge.mp3', 'common/game-over.mp3', 'common/stabbing.mp3', 'common/victory.mp3',
  'akyros/curse.mp3', 'akyros/hiddenmark.mp3', 'akyros/magic.mp3', 'akyros/shadowexecution.mp3', 'akyros/sword.mp3',
  'athena/curse.mp3', 'athena/divine_judgment.mp3', 'athena/divine_judgment_strike.mp3', 'athena/divinerestore.mp3', 'athena/sword_thud.mp3',
  'blade/blood_lick.mp3', 'blade/deepsea_cast.mp3', 'blade/deepsea_dodge.mp3', 'blade/deepsea_escape_fail.mp3', 'blade/deepsea_escape_success.mp3', 'blade/deepsea_strike.mp3', 'blade/focus.mp3', 'blade/rebirth.mp3', 'blade/sword.mp3',
  'boingo/chicken_attack.mp3', 'boingo/chicken_cast.mp3', 'boingo/chicken_hit.mp3', 'boingo/chicken_koed.mp3', 'boingo/coin.mp3', 'boingo/explosion.mp3', 'boingo/jesterball.mp3', 'boingo/kick.mp3', 'boingo/magic.mp3', 'boingo/miss.mp3', 'boingo/punch.mp3',
  'chronox/coin.mp3', 'chronox/cyclonepunch.mp3', 'chronox/freeze.mp3', 'chronox/rewind.mp3', 'chronox/world_stop.mp3',
  'draxus/axe_strike.mp3', 'draxus/deathless_fury.mp3',
  'grimtal/beast_attack.mp3', 'grimtal/beast_form.mp3', 'grimtal/bullet_hit.mp3', 'grimtal/head_spin.mp3', 'grimtal/magic_dodge.wav', 'grimtal/sword_thud.mp3',
  'illyra/illusion.mp3', 'illyra/mirage_burst.mp3', 'illyra/mirage_mark.mp3', 'illyra/mirage_overload.mp3',
  'kaelis/bird_heal.mp3', 'kaelis/bird_hit.mp3', 'kaelis/grudge_hit.mp3', 'kaelis/phoenix_dive.mp3', 'kaelis/wings_of_ashka.mp3',
  'marin/cleanSlate.mp3', 'marin/everbloom.wav', 'marin/magic.mp3', 'marin/magic_dodge.wav', 'marin/silent_study.wav', 'marin/wand_discover.mp3', 'marin/wand_strike.mp3',
  'melyssa/magic.mp3', 'melyssa/mind_control.mp3', 'melyssa/self_choke.mp3',
  'oraclus/correct.mp3', 'oraclus/doom_strike.mp3', 'oraclus/predict.mp3', 'oraclus/rune_strike.mp3', 'oraclus/rune_strike_strong.mp3', 'oraclus/wrong.mp3',
  'rowan/cloud.mp3', 'rowan/frog_curse_cast.mp3', 'rowan/frog_dodge_hop.mp3', 'rowan/healing.mp3', 'rowan/lightning.mp3', 'rowan/lock.mp3', 'rowan/magic.mp3', 'rowan/mirror.mp3', 'rowan/snake_bite.mp3', 'rowan/study.mp3', 'rowan/wand_strike.mp3',
  'tharox/earthshatter.mp3', 'tharox/smash.mp3', 'tharox/toss.mp3',
  'velorya/eclipse.mp3', 'velorya/magic.mp3', 'velorya/moonstep.mp3', 'velorya/sword.mp3',
  'zerathys/charge.mp3', 'zerathys/soul_storm.mp3', 'zerathys/soulswap.mp3', 'zerathys/thunder.mp3',
];
// Deliberately still excluded from SOUND_EFFECT_FILES preload (see the
// bandwidth-cap comment above) - every bgm-*.mp3 looping music track
// (common/ menu+battle, and the hero-themed ones under chronox/, boingo/,
// blade/), same "each startXMusic() fetches it live" reasoning.

let started = false;
// Deliberately NOT gating the battle screen's brief loading wait on this
// (unlike imagePreload.js's readyPromise, see battleImagesReady there) -
// this batch is far larger (every sound effect plus every character's
// voice lines) and would make that wait noticeably longer for no real
// benefit, since the reported annoyance was specifically about images.
// Kept simple/fire-and-forget as before.

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
