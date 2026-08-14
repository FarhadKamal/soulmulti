// Warms the browser's HTTP cache for every battle image up front, so mid-
// fight portrait swaps (setFlash in portraitFlash.js) never trigger a
// first-time network fetch - without this, the very first time a given
// action's flash image is needed, the <img>'s src swap has to actually wait
// on the network before it appears, which reads as "the effect is slow to
// show up" even though the flash timer itself is already running.
import { CHARACTER_IDS } from './characters.js';
import { v } from './assetVersion.js';

// Per-character, one file per folder, filename === characterId.
const PER_CHARACTER_FOLDERS = ['assets/portraits', 'assets/koed', 'assets/victory', 'assets/injured'];

// Flash/persistent-portrait images - filenames don't follow a fixed
// pattern (varies per character/action), so listed explicitly. Kept in
// sync with every literal 'assets/images/...jpg' path referenced in
// portraitFlash.js.
const FLASH_IMAGES = [
  'assets/images/akyros/dodge.jpg',
  'assets/images/akyros/fatal.jpg',
  'assets/images/akyros/hidden.jpg',
  'assets/images/akyros/rose.jpg',
  'assets/images/akyros/shadow.jpg',
  'assets/images/athena/apple.jpg',
  'assets/images/athena/curse.jpg',
  'assets/images/athena/heal.jpg',
  'assets/images/blade/alive.jpg',
  'assets/images/blade/guitar.jpg',
  'assets/images/blade/strike.jpg',
  'assets/images/boingo/circus.jpg',
  'assets/images/boingo/hardpunch.jpg',
  'assets/images/boingo/laughing.jpg',
  'assets/images/boingo/miss.jpg',
  'assets/images/boingo/normalpunch.jpg',
  'assets/images/boingo/throwing.jpg',
  'assets/images/chronox/cyclone.jpg',
  'assets/images/chronox/space.jpg',
  'assets/images/chronox/time.jpg',
  'assets/images/tharox/glory.jpg',
  'assets/images/tharox/roar.jpg',
  'assets/images/tharox/smash.jpg',
  'assets/images/tharox/toss.jpg',
  'assets/images/velorya/casting.jpg',
  'assets/images/velorya/dance.jpg',
  'assets/images/velorya/hided.jpg',
  'assets/images/velorya/strike.jpg',
  'assets/images/zerathys/charge.jpg',
  'assets/images/zerathys/glass.jpg',
  'assets/images/zerathys/soul.jpg',
  'assets/images/zerathys/strike.jpg',
  'assets/images/melyssa/chess.jpg',
  'assets/images/melyssa/mind_control_selection.jpg',
  'assets/images/melyssa/mind_control_action.jpg',
  'assets/images/melyssa/self_choke.jpg',
  'assets/images/kaelis/idle.jpg',
  'assets/images/kaelis/grudge.jpg',
  'assets/images/kaelis/bird.jpg',
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
