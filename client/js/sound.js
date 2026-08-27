// Ported from the main game's js/engine/sound.js - same action-sound
// mapping and autoplay-policy workaround, adapted for the multiplayer
// client (menu music while in the lobby, battle music once a match starts,
// no local-only concepts like undo/turn-tick sounds since those don't
// apply here).
import { v } from './assetVersion.js';

const cache = {};

// name may include its own extension (e.g. 'everbloom.wav', needed for
// Marin's 2 non-mp3 sound effects) - defaults to appending .mp3 when it
// doesn't, matching every existing call site's behavior unchanged.
function get(name) {
  const file = /\.\w+$/.test(name) ? name : `${name}.mp3`;
  if (!cache[name]) {
    cache[name] = new Audio(v(`assets/sounds/${file}`));
  }
  return cache[name];
}

let musicAudio = null;
let musicTrack = null; // 'menu' | 'battle' | null

const BATTLE_TRACKS = ['bgm-battle.mp3', 'bgm-battle-2.mp3', 'bgm-battle-3.mp3'];
const MENU_TRACKS = ['bgm-menu.mp3', 'bgm-menu-2.mp3', 'bgm-menu-3.mp3'];

// Browsers block audio autoplay until the user has interacted with the
// page. Two distinct failure modes seen in practice: (1) a play() call
// made asynchronously (e.g. from a WebSocket message handler, not
// synchronously inside a click handler) can be blocked even after an
// earlier gesture already unblocked a DIFFERENT audio element - switching
// from menu music to a freshly-created battle-track Audio node hit this in
// testing: menu music played fine (its play() happened to line up with an
// early interaction), but the battle track silently stayed paused with no
// rejection once startBattleMusic() fired from the game-state handler.
// (2) some browsers just leave the element paused with no promise
// rejection at all regardless of timing. Both are self-healed by
// unconditionally re-checking (not just once, on every interaction) rather
// than trusting either the initial play() call or a single retry.
function ensureMusicPlaying() {
  if (musicAudio && musicAudio.paused) {
    musicAudio.play().catch(() => {});
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', ensureMusicPlaying);
  document.addEventListener('keydown', ensureMusicPlaying);
  // Belt-and-suspenders: also poll periodically, since a click landing on
  // an element with its own handler can still fire pointerdown/keydown but
  // in some browsers doesn't count as a "sticky activation" gesture for a
  // brand new Audio element created moments earlier - a short interval
  // catches it within a second or two regardless of exactly which click
  // qualifies.
  setInterval(ensureMusicPlaying, 1000);
}

function startMusic(track, file, volume) {
  if (musicTrack === track) return;
  if (musicAudio) musicAudio.pause();
  try {
    const node = new Audio(v(`assets/sounds/${file}`));
    node.loop = true;
    node.volume = volume;
    node.play().catch(() => {});
    musicAudio = node;
    musicTrack = track;
  } catch {
    // ignore
  }
}

export function startMenuMusic() {
  musicTrack = null;
  const file = MENU_TRACKS[Math.floor(Math.random() * MENU_TRACKS.length)];
  startMusic('menu', file, 0.3);
}

export function startBattleMusic() {
  musicTrack = null;
  const file = BATTLE_TRACKS[Math.floor(Math.random() * BATTLE_TRACKS.length)];
  startMusic('battle', file, 0.25);
}

export function stopMusic() {
  if (musicAudio) {
    musicAudio.pause();
    musicAudio = null;
    musicTrack = null;
  }
}

export function playSound(name) {
  try {
    const base = get(name);
    const node = base.cloneNode();
    node.volume = 0.6;
    node.play().catch(() => {});
  } catch {
    // ignore
  }
}

const ACTION_SOUND = {
  cyclonePunch: 'cyclonepunch',
  timeFreeze: 'freeze',
  smash: 'smash',
  titanToss: 'toss',
  titanSmash: 'smash',
  glorySmash: 'smash',
  chargeUp: 'charge',
  thunderWrath: 'thunder',
  soulSwap: 'soulswap',
  soulSwapWrath: 'thunder',
  hiddenMark: 'hiddenmark',
  fatalSlash: 'sword',
  shadowExecution: 'shadowexecution',
  lunarStrike: 'sword',
  moonstep: 'moonstep',
  lunarEclipse: 'eclipse',
  chaosGamble: 'punch',
  jesterBall: 'jesterball',
  bloodHunt: 'sword',
  curseStrike: 'curse',
  divineRestore: 'divinerestore',
  selfChoke: 'self_choke',
  grudgeStrike: 'grudge_hit',
  callAshka: 'bird_heal',
  dyingBlow: 'axe_strike',
  deathlessFury: 'deathless_fury',
  wandStrike: 'wand_strike',
  arcaneStudy: 'study',
  poisonCloud: 'cloud',
  purify: 'healing',
  wildLightning: 'lightning',
  mirrorReflect: 'mirror',
  silenceLock: 'lock',
  // Marin: all 5 fire once, at the moment each is discovered (see
  // main.js's 'spell-discovered' handler) - none of them are cast
  // separately later, unlike Rowan's kit. Piercing Wand and Wand Mastery
  // deliberately share one sound (wandDiscover -> wand_discover.mp3), both
  // being permanent "the wand just got better" announcements.
  everbloom: 'everbloom.wav',
  threefoldVeil: 'magic_dodge.wav',
  cleanSlate: 'cleanSlate',
  wandDiscover: 'wand_discover',
  grimStrike: 'sword_thud',
  skullCrack: 'bullet_hit',
  // Reuses Grimtal's spear-thrust impact sound - fitting for her own
  // spear-lunge sacrifice attack, per explicit request.
  divineSacrifice: 'sword_thud',
  mirageMark: 'mirage_mark',
  mirageBurst: 'mirage_burst',
  rewind: 'rewind',
  runeStrike: 'rune_strike',
  runeVision: 'predict',
};

export function playActionSound(actionId) {
  const name = ACTION_SOUND[actionId];
  if (name) playSound(name);
}

export function playUiClick() {
  playSound('click');
}

export function playKO() {
  playSound('game-over');
}

export function playVictory() {
  playSound('victory');
}

export function playCoin() {
  playSound('coin');
}

export function playRebirth() {
  playSound('rebirth');
}

export function playDodge() {
  playSound('dodge');
}
