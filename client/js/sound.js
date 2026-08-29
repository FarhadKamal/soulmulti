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
// Tharox's Earthshatter/Boingo's ball etc. don't touch background music at
// all - Chronox's World Stops is the one exception (confirmed ruling):
// while every opponent is frozen, the normal battle track is replaced by a
// dedicated tick-tock ambient track for the duration, reverting to
// whichever track was actually playing before once the full freeze ends
// (main.js's 'world-stops-end' handler calls revertFromFrozenMusic).
const FROZEN_TRACK = 'bgm-frozen.mp3';
let preFrozenTrack = null; // 'menu' | 'battle' | null - remembers what to restore

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

// Chronox's World Stops: swaps in a dedicated tick-tock ambient track for
// as long as every opponent is frozen. Remembers whichever track was
// actually playing (menu or battle) so revertFromFrozenMusic can restore
// the correct one afterward, rather than assuming it was always battle
// music (a freeze cast mid-victory-sequence or similar edge case could
// otherwise wrongly force menu music back to battle music).
export function startFrozenMusic() {
  if (musicTrack === 'frozen') return;
  preFrozenTrack = musicTrack;
  startMusic('frozen', FROZEN_TRACK, 0.28);
}

export function revertFromFrozenMusic() {
  if (musicTrack !== 'frozen') return;
  const restoreTo = preFrozenTrack;
  preFrozenTrack = null;
  musicTrack = null; // force startMusic's own "already on this track" guard to actually re-trigger
  if (restoreTo === 'menu') {
    startMenuMusic();
  } else {
    // Also the safe default for restoreTo === null (frozen music started
    // before any track had genuinely begun playing yet - shouldn't happen
    // in practice mid-match, but battle music is the correct fallback
    // during an active match regardless).
    startBattleMusic();
  }
}

export function stopMusic() {
  if (musicAudio) {
    musicAudio.pause();
    musicAudio = null;
    musicTrack = null;
  }
}

// Tharox's Earthshatter sound effect gets an exclusive hold on this whole
// layer - confirmed ruling: while it's playing, no other sound effect
// should play at all, not even one from an unrelated later action (the
// next player's own move sound, a dodge, etc.). Sound effects normally
// have zero exclusivity at all (every playSound() call just clones and
// plays freely, layering on top of whatever else is already going - fine
// for short, ordinary hits, but wrong for this one deliberately climactic
// moment). earthshatter.mp3 runs ~5.2s - the lock is sized to its own real
// duration, same reasoning as EARTHSHATTER_VOICE_LOCK_MS in voice.js for
// the voice layer.
const EARTHSHATTER_SOUND_LOCK_MS = 5200;
// game-over/rebirth are exempt from the lock, same "biggest/rarest
// moments are never drowned out" reasoning voice.js's koed/rebirth
// exemption already uses for the voice layer - a KO or a revival landing
// mid-Earthshatter shouldn't go silent just because he happened to cast it
// first.
const SOUND_LOCK_EXEMPT = new Set(['earthshatter', 'game-over', 'rebirth']);
let soundLockUntil = 0;

export function playSound(name) {
  const now = Date.now();
  if (now < soundLockUntil && !SOUND_LOCK_EXEMPT.has(name)) return;
  try {
    const base = get(name);
    const node = base.cloneNode();
    node.volume = 0.6;
    node.play().catch(() => {});
    if (name === 'earthshatter') soundLockUntil = now + EARTHSHATTER_SOUND_LOCK_MS;
  } catch {
    // ignore
  }
}

const ACTION_SOUND = {
  cyclonePunch: 'cyclonepunch',
  timeFreeze: 'freeze',
  worldStops: 'world_stop',
  smash: 'smash',
  titanToss: 'toss',
  titanSmash: 'smash',
  glorySmash: 'smash',
  earthshatter: 'earthshatter',
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
  mirageOverload: 'mirage_overload',
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
