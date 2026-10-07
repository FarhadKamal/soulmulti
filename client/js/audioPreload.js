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
  'akyros/shadow_seal.mp3', 'akyros/hidden_mark.mp3', 'akyros/shadow_toll.mp3', 'akyros/shadow_execution.mp3', 'akyros/fatal_slash.mp3',
  'athena/curse_strike.mp3', 'athena/divine_judgment.mp3', 'athena/divine_judgment_strike.mp3', 'athena/divine_restore.mp3', 'athena/divine_sacrifice.mp3',
  'blade/blood_drain.mp3', 'blade/shark_hunt.mp3', 'blade/shark_strike_dodge.mp3', 'blade/escape_seal_fail.mp3', 'blade/escape_seal_success.mp3', 'blade/shark_strike.mp3', 'blade/focus.mp3', 'blade/rebirth.mp3', 'blade/blood_hunt.mp3',
  'boingo/chicken_attack.mp3', 'boingo/fowl_play.mp3', 'boingo/chicken_hit.mp3', 'boingo/chicken_koed.mp3', 'boingo/jester_ball_checkpoint.mp3', 'boingo/jester_ball_explosion.mp3', 'boingo/jester_ball.mp3', 'boingo/jester_ball_pass.mp3', 'boingo/jester_ball_return.mp3', 'boingo/chaos_gamble_miss.mp3', 'boingo/chaos_gamble.mp3',
  'chronox/cyclone_punch.mp3', 'chronox/time_freeze.mp3', 'chronox/rewind.mp3', 'chronox/world_stops.mp3',
  'draxus/dying_blow.mp3', 'draxus/deathless_fury.mp3', 'draxus/cheat_death.mp3',
  'grimtal/beast_attack.mp3', 'grimtal/beast_form.mp3', 'grimtal/skull_crack.mp3', 'grimtal/skull_crack_headache.mp3', 'grimtal/grim_ward.wav', 'grimtal/grim_strike.mp3',
  'illyra/illusion_dodge.mp3', 'illyra/mirage_burst.mp3', 'illyra/mirage_mark.mp3', 'illyra/mirage_overload.mp3',
  'kaelis/call_ashka.mp3', 'kaelis/ashkas_vengeance.mp3', 'kaelis/grudge_strike.mp3', 'kaelis/phoenix_dive.mp3', 'kaelis/wings_of_ashka.mp3',
  'marin/clean_slate.mp3', 'marin/everbloom.wav', 'marin/lifebond.mp3', 'marin/threefold_veil.wav', 'marin/arcane_study.wav', 'marin/piercing_wand.mp3', 'marin/wand_mastery.mp3', 'marin/wand_strike.mp3',
  'melyssa/friendship.mp3', 'melyssa/mind_control.mp3', 'melyssa/self_choke.mp3',
  'oraclus/rune_vision_correct.mp3', 'oraclus/prophecy_of_doom_strike.mp3', 'oraclus/rune_vision.mp3', 'oraclus/prophecy_of_doom.mp3', 'oraclus/rune_strike.mp3', 'oraclus/rune_strike_strong.mp3', 'oraclus/rune_vision_wrong.mp3',
  'rowan/poison_cloud.mp3', 'rowan/frog_curse.mp3', 'rowan/frog_dodge.mp3', 'rowan/purify.mp3', 'rowan/wild_lightning.mp3', 'rowan/silence_lock.mp3', 'rowan/petrify.mp3', 'rowan/mirror_reflect.mp3', 'rowan/snake_strike.mp3', 'rowan/arcane_study.mp3', 'rowan/wand_strike.mp3',
  'tharox/earthshatter.mp3', 'tharox/glory_smash.mp3', 'tharox/smash.mp3', 'tharox/titan_smash.mp3', 'tharox/titan_toss.mp3',
  'velorya/lunar_eclipse.mp3', 'velorya/moonlit_theft.mp3', 'velorya/moonstep.mp3', 'velorya/lunar_strike.mp3',
  'zerathys/charge_up.mp3', 'zerathys/soul_storm.mp3', 'zerathys/soul_swap.mp3', 'zerathys/thunder_wrath.mp3',
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
