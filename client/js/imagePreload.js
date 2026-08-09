// Warms the browser's HTTP cache for every battle image up front, so mid-
// fight portrait swaps (setFlash in portraitFlash.js) never trigger a
// first-time network fetch - without this, the very first time a given
// action's flash image is needed, the <img>'s src swap has to actually wait
// on the network before it appears, which reads as "the effect is slow to
// show up" even though the flash timer itself is already running.
import { CHARACTER_IDS } from './characters.js';
import { v } from './assetVersion.js';

// Per-character, one file per folder, filename === characterId.
const PER_CHARACTER_FOLDERS = ['assets/portraits', 'assets/koed', 'assets/victory', 'assets/images/injured'];

// Flash/persistent-portrait images - filenames don't follow a fixed
// pattern (varies per character/action), so listed explicitly. Kept in
// sync with every literal 'assets/images/...jpg' path referenced in
// portraitFlash.js.
const FLASH_IMAGES = [
  'assets/images/akyros_dodge.jpg',
  'assets/images/akyros_fatal.jpg',
  'assets/images/akyros_hidden.jpg',
  'assets/images/akyros_rose.jpg',
  'assets/images/akyros_shadow.jpg',
  'assets/images/athena_apple.jpg',
  'assets/images/athena_curse.jpg',
  'assets/images/athena_heal.jpg',
  'assets/images/blade_alive.jpg',
  'assets/images/blade_guitar.jpg',
  'assets/images/blade_strike.jpg',
  'assets/images/boingo_circus.jpg',
  'assets/images/boingo_hardpunch.jpg',
  'assets/images/boingo_laughing.jpg',
  'assets/images/boingo_miss.jpg',
  'assets/images/boingo_normalpunch.jpg',
  'assets/images/boingo_throwing.jpg',
  'assets/images/chronox_cyclone.jpg',
  'assets/images/chronox_space.jpg',
  'assets/images/chronox_time.jpg',
  'assets/images/tharox_glory.jpg',
  'assets/images/tharox_roar.jpg',
  'assets/images/tharox_smash.jpg',
  'assets/images/tharox_toss.jpg',
  'assets/images/velorya_casting.jpg',
  'assets/images/velorya_dance.jpg',
  'assets/images/velorya_hided.jpg',
  'assets/images/velorya_strike.jpg',
  'assets/images/zerathys_charge.jpg',
  'assets/images/zerathys_glass.jpg',
  'assets/images/zerathys_soul.jpg',
  'assets/images/zerathys_strike.jpg',
];

let started = false;

export function preloadBattleImages() {
  if (started) return;
  started = true;
  const paths = [...FLASH_IMAGES];
  for (const folder of PER_CHARACTER_FOLDERS) {
    for (const id of CHARACTER_IDS) paths.push(`${folder}/${id}.jpg`);
  }
  // Plain Image() objects, never attached to the DOM - the browser caches
  // the response as soon as it loads regardless, so a later portrait.src =
  // same path is served from cache instantly. No onload/onerror handling
  // needed - a failed/missing file here just means that one swap falls
  // back to its normal (slower) first-use fetch, same as before this file
  // existed.
  for (const path of paths) {
    const img = new Image();
    img.src = v(path);
  }
}
