// Ported from the main game's js/engine/sound.js - same action-sound
// mapping and autoplay-policy workaround, adapted for the multiplayer
// client (menu music while in the lobby, battle music once a match starts,
// no local-only concepts like undo/turn-tick sounds since those don't
// apply here).
const cache = {};

function get(name) {
  if (!cache[name]) {
    cache[name] = new Audio(`assets/sounds/${name}.mp3`);
  }
  return cache[name];
}

let musicAudio = null;
let musicTrack = null; // 'menu' | 'battle' | null

const BATTLE_TRACKS = ['bgm-battle.mp3', 'bgm-battle-2.mp3', 'bgm-battle-3.mp3'];
const MENU_TRACKS = ['bgm-menu.mp3', 'bgm-menu-2.mp3', 'bgm-menu-3.mp3'];

// Browsers block audio autoplay until the user has interacted with the
// page - the very first call to startMenuMusic() happens on initial page
// load, before any click/tap. Some browsers reject the play() promise
// (caught in startMusic below); others silently leave the element paused
// with no rejection at all - so this also arms an unconditional "on any
// interaction, make sure music is actually playing" listener, which
// self-heals either failure mode.
function ensureMusicPlaying() {
  if (musicAudio && musicAudio.paused) {
    musicAudio.play().catch(() => {});
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', ensureMusicPlaying);
  document.addEventListener('keydown', ensureMusicPlaying);
}

function startMusic(track, file, volume) {
  if (musicTrack === track) return;
  if (musicAudio) musicAudio.pause();
  try {
    const node = new Audio(`assets/sounds/${file}`);
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

export function playSpecial() {
  playSound('success');
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
