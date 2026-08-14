import { connect, onMessage, saveReconnectInfo, clearReconnectInfo } from './net.js';
import { renderLobby } from './lobbyScreen.js';
import { renderBattle } from './battleScreen.js';
import { addChatMessage, clearChatMessages } from './chatPanel.js';
import {
  startMenuMusic, startBattleMusic, stopMusic,
  playActionSound, playSound, playKO, playVictory, playDodge, playRebirth, playCoin,
} from './sound.js';
import { handleLogEntryForFlash, handleDodgeForFlash, checkIdlePortrait, registerFlashRerender } from './portraitFlash.js';
import { handleLogEntryForEffects, registerEffectRerender } from './actionEffects.js';
import { preloadBattleImages } from './imagePreload.js';
import { preloadBattleAudio } from './audioPreload.js';
import { hasVoice, playIdleVoice, playInjuredVoice, playKoedVoice, playVictoryVoice, playMoveVoice, playLaughVoice, playRebirthVoice } from './voice.js';

const root = document.getElementById('app');

const state = {
  screen: 'lobby', // 'lobby' | 'battle'
  room: null,
  error: null,
  connectionLost: false,
  game: null,
  actingCharacterId: null,
  usableActions: [],
  awaitingSoulSwapWrath: false,
  // Mirrors awaitingSoulSwapWrath's pattern for Melyssa's own two-stage
  // Mind Control flow - true from the moment she selects a puppet through
  // to the puppeted action (and any nested follow-up) fully resolving.
  // mindControlPuppetId is whichever character she's currently puppeting -
  // drives both the stage-2 action panel and the puppet's tile highlight.
  awaitingMindControlAction: false,
  mindControlPuppetId: null,
  armedAction: null,
  confirmingExit: false,
  turnDeadline: null,
  humanCount: null,
  // Staged game-over transition, mirroring the main game's own
  // gameOverBannerShown/showVictoryArt sequence: 'freeze' (board stays up
  // so the winning action's flash/shake/portrait is actually seen, not cut
  // away from instantly) -> 'victory' (winning character(s) art) ->
  // 'banner' (the actual Match Over screen). null while not in game-over.
  gameOverStage: null,
  rerender,
};

// Tracks how much of game.log has already been "heard" so incoming
// game-state broadcasts only react to genuinely NEW entries, not the whole
// log again on every update. Also tracks the previously-acting character
// to detect "a new character's turn just started" for the idle-portrait
// check (see portraitFlash.js's checkIdlePortrait).
let lastLogLength = 0;
let previousActingCharacterId = null;
// Tracks each character's hearts as of the LAST broadcast seen (not just
// at their own turn start, unlike checkIdlePortrait's heartsAtLastTurnStart
// - injured needs to fire the instant a hit drops someone below half,
// which can happen on someone else's turn, not only at the start of the
// injured character's own next turn) - lets playInjuredVoiceIfNewlyHurt
// detect the exact broadcast where a character first crosses into
// "at or below half health" rather than firing on every later broadcast
// while they stay in that range.
const lastKnownHearts = new Map(); // characterId -> number

// Fires a character's injured voice line the FIRST broadcast where their
// hearts cross into <= maxHearts/2 (never again afterward while they stay
// there, and never for a character who was already at/below half on the
// very first broadcast we ever saw them in - there's no "before" state to
// compare against yet, so nothing to call a fresh transition).
function playInjuredVoiceIfNewlyHurt(game) {
  for (const character of Object.values(game.characters)) {
    const prev = lastKnownHearts.has(character.id) ? lastKnownHearts.get(character.id) : null;
    lastKnownHearts.set(character.id, character.hearts);
    if (character.isKO || prev === null) continue;
    const isInjuredNow = character.hearts <= character.maxHearts / 2;
    const wasInjuredBefore = prev <= character.maxHearts / 2;
    if (isInjuredNow && !wasInjuredBefore) playInjuredVoice(character.id);
  }
}

// Guards the game-over timer chain (see startGameOverSequence below) so a
// repeat game-state broadcast or an unrelated rerender (e.g. a chat
// message arriving) while already mid-sequence doesn't stack a second,
// independent set of setTimeouts on top of the first one.
let gameOverSequenceStarted = false;

// Same staged reveal as the main game's dashboardScreen.js render(): freeze
// on the live board first (so the winning action's own flash/shake/
// portrait effect is actually seen, matching actionEffects.js's own
// 1600ms-ish timers rather than being cut away from instantly), then show
// victory art, then finally the Match Over banner. ~1.2s + ~3.8s, same
// total as the main game's own two-stage delay.
function startGameOverSequence(game) {
  if (gameOverSequenceStarted) return;
  gameOverSequenceStarted = true;
  state.gameOverStage = 'freeze';
  setTimeout(() => {
    if (state.screen !== 'battle') return; // torn down (left the room) mid-sequence
    state.gameOverStage = 'victory';
    rerender();
    setTimeout(() => {
      if (state.screen !== 'battle') return;
      state.gameOverStage = 'banner';
      // Battle music stops and menu music takes over the instant the
      // actual Match Over screen appears - previously it just kept playing
      // straight through victory/defeat and into the post-match banner,
      // which read as the fight never really ending.
      startMenuMusic();
      // A recorded voice REPLACES the generic victory jingle (see
      // playVictoryVoice/hasVoice in voice.js) - the winning side can have
      // more than one character (2v2/4p teams), and one of them may have
      // been KO'd earlier in the match while a TEAMMATE finished the fight
      // (a real bug this fixes: heard Boingo's victory line despite Boingo
      // being KO'd, because he simply came first in characterIds and had a
      // recorded voice - Akyros, the actual survivor, was never checked).
      // Only a character who's still alive (!isKO) can speak for the win;
      // plays the first SURVIVING one that also has a recorded line,
      // falling back to the generic jingle if none of the survivors do (or
      // it's a draw, no winnerPlayerId at all).
      const winner = game.winnerPlayerId ? game.players.find((p) => p.id === game.winnerPlayerId) : null;
      const voiceCharacterId = winner?.characterIds
        .filter((id) => !game.characters[id]?.isKO)
        .find(hasVoice);
      if (!voiceCharacterId || !playVictoryVoice(voiceCharacterId)) playVictory();
      rerender();
    }, 3800);
  }, 1200);
}

function processNewLogEntries(game) {
  const newEntries = game.log.slice(lastLogLength);
  lastLogLength = game.log.length;
  for (const entry of newEntries) {
    playLogEntrySound(entry, game);
    handleLogEntryForFlash(entry, game);
    handleDodgeForFlash(entry, game);
    handleLogEntryForEffects(entry, game);
  }
}

// Mirrors the main game's playPostActionSounds/finishJesterBall sound
// dispatch exactly - same priority order (rebirth beats dodge beats the
// normal action sound, since an ability that revives or gets dodged never
// also plays its own hit sound on top), same per-actionId special cases
// (Cyclone Punch's extra coin-flip sound, Chaos Gamble's distinct miss
// sound on a losing roll), and the same four distinct Jester Ball
// resolution sounds (throw/pass/take-explode-or-revive/return) instead of
// reusing one sound for all of them.
// KO'd voice REPLACES the generic game-over sound for a recorded character
// (playKoedVoice returns true once it actually played something) - falls
// back to the generic sound for any character without a recorded koed
// line yet, same as every other voice/sound fallback in this file.
function playKoedFor(characterId) {
  if (!playKoedVoice(characterId)) playKO();
}

// A KO'd character shouldn't have a voice line play for them - mirrors
// portraitFlash.js's handleLaughing, which already skips the laughing
// portrait flash once Boingo is KO'd (e.g. KO'd earlier in the same pass
// chain, before the ball goes on to explode on someone else). Without this,
// the laugh line would still play even though Boingo himself is down and
// nothing shows on screen to justify it.
function playLaughVoiceIfAlive(characterId, game) {
  if (game.characters[characterId]?.isKO) return;
  playLaughVoice(characterId);
}

function playLogEntrySound(entry, game) {
  if (entry.type === 'dodge') {
    playDodge();
    return;
  }
  if (entry.type === 'rebirth') {
    playRebirth();
    // Layered on top, never replacing the generic rebirth sound - a no-op
    // for anyone but Blade (see voice.js's playRebirthVoice).
    playRebirthVoice(entry.targetCharacterId);
    return;
  }
  if (entry.type === 'curse-mirror') {
    if (entry.koTriggered) setTimeout(() => playKoedFor(entry.toCharacterId), 200);
    return;
  }
  if (entry.type === 'jester-ball-pass') {
    playSound('kick');
    return;
  }
  if (entry.type === 'jester-ball-return') {
    playSound('magic');
    // Layered on top, never replacing the return sound - a no-op for
    // anyone but Boingo (see voice.js's playLaughVoice), and for a KO'd
    // Boingo (see playLaughVoiceIfAlive above).
    playLaughVoiceIfAlive(entry.boingoId, game);
    return;
  }
  if (entry.type === 'jester-ball-take') {
    // Explodes on the holder UNLESS it triggered Blade's Rebirth instead -
    // that case gets its own dedicated 'rebirth' entry right after this
    // one (handled above), so skip the explosion sound here to avoid
    // playing both for the same event. Its own dedicated 'explosion' sound
    // (previously reused Tharox's 'smash' effect, since both are impact
    // sounds - now distinct so updating one doesn't also change the other).
    if (!entry.revived) {
      playSound('explosion');
      // Boingo gets the last laugh whenever the ball bursts on SOMEONE
      // ELSE - not when it bursts on himself (he can hold his own ball
      // mid-pass-chain in a multi-target room). A no-op for anyone but
      // Boingo, a no-op if he's the one it exploded on, and (via
      // playLaughVoiceIfAlive) a no-op if he was already KO'd earlier in
      // this same pass chain before it went on to explode on someone else.
      if (entry.targetCharacterId !== 'boingo') playLaughVoiceIfAlive('boingo', game);
      if (entry.koTriggered) setTimeout(() => playKoedFor(entry.targetCharacterId), 200);
    }
    return;
  }
  if (entry.type === 'mind-control-select') {
    playSound('mind_control');
    // Layered on top, never replacing the selection sound - a no-op for
    // anyone but Melyssa.
    playMoveVoice(entry.characterId, 'mindControl');
    return;
  }
  // Curse Strike ('curse') and Hidden Mark ('hidden-mark') each log their
  // own dedicated type rather than 'attack'/'special'/'setup' - same
  // reasoning as portraitFlash.js's equivalent branches - so they need
  // their own actionId here too, since the generic dispatch below only
  // ever sees 'attack'/'special'/'setup' entries.
  if (entry.type === 'curse') {
    playActionSound('curseStrike');
    return;
  }
  if (entry.type === 'hidden-mark') {
    playActionSound('hiddenMark');
    // Deliberately vague voice line (see the akyros hidden_mark recording)
    // - doesn't name the target, matching the mark itself being secret
    // from everyone but Akyros. Layered on top, a no-op for anyone but him.
    playMoveVoice(entry.characterId, 'hiddenMark');
    return;
  }
  if (entry.type !== 'attack' && entry.type !== 'special' && entry.type !== 'setup') return;

  // A dodged hit already got its own 'dodge' log entry (and playDodge()
  // above) - the ability's own attack/special entry still gets pushed
  // alongside it (with dodged:true, amountDealt 0), but per the main
  // game's playPostActionSounds, dodge and the normal action sound are
  // mutually exclusive, not layered.
  if (entry.dodged) return;

  if (entry.actionId === 'cyclonePunch') playCoin();
  if (entry.actionId === 'chaosGamble' && entry.outcome === 'lose') {
    playSound('miss');
    return;
  }
  playActionSound(entry.actionId);
  // Layered on top of the effect sound just played above, never replacing
  // it (see voice.js's playMoveVoice) - a no-op for any character/action
  // that isn't one of the 4 recorded signature moves so far.
  playMoveVoice(entry.characterId, entry.actionId);
  if (entry.koTriggered) setTimeout(() => playKoedFor(entry.targetCharacterId), 200);
}

function mySeatCharacterIds() {
  if (!state.room || state.room.mySeatIndex === null) return [];
  return state.room.seats[state.room.mySeatIndex]?.characterIds || [];
}

function rerender() {
  if (state.screen === 'lobby') {
    renderLobby(root, { room: state.room, error: state.error, connectionLost: state.connectionLost }, {
      onEnterMatch: () => { state.screen = 'battle'; rerender(); },
      rerender,
    });
  } else {
    // Pass the REAL state object through (not a fresh literal) - battleScreen
    // mutates state.armedAction directly (e.g. arming a targeted action, or
    // Jester Ball's Pass target-pick mode) and expects that mutation to
    // stick across the next rerender(). An earlier version built a new
    // object literal here each call, which meant those mutations landed on
    // a throwaway copy and got silently discarded - clicking any action
    // that needs a target (i.e. everything except Charge Up) appeared to do
    // nothing, since armedAction always reset back to whatever main.js's
    // real state had, never what the click just set.
    state.mySeatCharacterIds = mySeatCharacterIds();
    renderBattle(root, state);
  }
}

onMessage((msg) => {
  switch (msg.type) {
    case 'session':
      break; // net.js tracks this internally
    case 'room-created':
    case 'room-joined':
      state.error = null;
      // A brand new room context - the previous room's chat has nothing
      // to do with this one (see clearChatMessages's own comment for the
      // bug this fixes).
      clearChatMessages();
      // training4/bots4 rooms don't send a reconnectToken (see
      // handleCreateRoom/handleJoinRoom in index.js - only real 2p/4p seat
      // claims issue one), so this is naturally a no-op for those.
      if (msg.reconnectToken) {
        saveReconnectInfo({ roomCode: msg.code, seatIndex: msg.seatIndex, reconnectToken: msg.reconnectToken });
      }
      break;
    case 'lobby-update':
      state.room = msg.room;
      state.error = null;
      // A lobby-update while the room's phase is back to 'lobby' means the
      // owner sent return-to-lobby (after a match ended) or abandon-match
      // (mid-match), or this is just the normal pre-match flow - either
      // way, the battle screen should stop showing (it has no way to
      // update itself once the server's game object is gone / a new match
      // hasn't started yet).
      if (msg.room.phase === 'lobby') {
        if (state.screen !== 'lobby') startMenuMusic();
        state.screen = 'lobby';
        lastLogLength = 0; // next match starts a fresh game.log from []
        previousActingCharacterId = null;
        lastKnownHearts.clear(); // next match's characters start fresh, nothing "already seen" yet
        gameOverSequenceStarted = false; // next match gets its own fresh sequence
        state.gameOverStage = null;
      } else if (msg.room.phase === 'in-match' && state.screen !== 'battle') {
        // lobbyScreen.js's onEnterMatch flips state.screen to 'battle' the
        // instant it sees room.phase 'in-match' here, BEFORE the first
        // game-state broadcast for the new match arrives - so the
        // `state.screen !== 'battle'` check that used to gate
        // startBattleMusic() inside the 'game-state' case below was always
        // false by the time that broadcast landed (screen had already
        // flipped here), and battle music never started, leaving menu
        // music playing through the whole match. Start it here instead, at
        // the actual moment the screen transition happens.
        startBattleMusic();
      }
      rerender();
      break;
    case 'game-state':
      state.screen = 'battle';
      state.game = msg.game;
      state.actingCharacterId = msg.actingCharacterId;
      state.usableActions = msg.usableActions || [];
      state.awaitingSoulSwapWrath = !!msg.awaitingSoulSwapWrath;
      state.awaitingMindControlAction = !!msg.awaitingMindControlAction;
      state.mindControlPuppetId = msg.mindControlPuppetId ?? null;
      state.armedAction = null;
      state.confirmingExit = false;
      state.turnDeadline = msg.turnDeadline || null;
      state.humanCount = msg.humanCount ?? null;
      processNewLogEntries(msg.game);
      playInjuredVoiceIfNewlyHurt(msg.game);
      // A fresh turn just started for whoever's now acting (different from
      // who was acting on the previous broadcast) - check their idle
      // portrait (Athena's apple, Velorya's dance, etc.) the same moment
      // the main game's beginCharacterTurn hook does.
      if (msg.actingCharacterId && msg.actingCharacterId !== previousActingCharacterId) {
        const character = msg.game.characters[msg.actingCharacterId];
        if (character && checkIdlePortrait(character)) playIdleVoice(character.id);
      }
      previousActingCharacterId = msg.actingCharacterId;
      if (msg.game.phase === 'game-over') startGameOverSequence(msg.game);
      rerender();
      break;
    case 'error':
      state.error = msg.message;
      rerender();
      break;
    case 'connection-closed':
      state.error = 'Connection lost.';
      state.connectionLost = true;
      stopMusic();
      rerender();
      break;
    case 'left-room':
      // Confirmation that leave-room was processed - reset back to the
      // entry screen (create/join), same connection stays open. Nothing
      // left to reconnect into once you've deliberately left.
      clearReconnectInfo();
      state.screen = 'lobby';
      state.room = null;
      state.game = null;
      state.error = null;
      lastLogLength = 0;
      previousActingCharacterId = null;
      lastKnownHearts.clear();
      clearChatMessages();
      startMenuMusic();
      rerender();
      break;
    case 'kicked':
      // The room owner removed this player's seat directly (see
      // handleKickPlayer in index.js) - same reset as left-room, but with
      // an explicit notice so it reads as a deliberate host action, not a
      // random disconnect/bug.
      clearReconnectInfo();
      state.screen = 'lobby';
      state.room = null;
      state.game = null;
      state.error = 'You were removed from the room by the host.';
      lastLogLength = 0;
      previousActingCharacterId = null;
      lastKnownHearts.clear();
      clearChatMessages();
      startMenuMusic();
      rerender();
      break;
    case 'reconnect-failed':
      // The saved token didn't resolve to an active grace period (already
      // expired, wrong room/seat, or the room's gone) - clear the stale
      // entry so future connects don't keep retrying a dead reconnect, and
      // let the player land on the normal entry screen instead of hanging.
      clearReconnectInfo();
      rerender();
      break;
    case 'chat-message':
      addChatMessage(msg);
      rerender();
      break;
    default:
      break;
  }
});

registerFlashRerender(() => { if (state.screen === 'battle') rerender(); });
registerEffectRerender(() => { if (state.screen === 'battle') rerender(); });
// Keeps the fullscreen button's icon/title correct even when fullscreen is
// exited via Escape (or any OS-level gesture) rather than the button
// itself - document.fullscreenElement changes without any click of ours.
document.addEventListener('fullscreenchange', rerender);
// Fire-and-forget: warms the browser's cache for every battle portrait/
// flash image before the player even reaches a match, so mid-fight
// portrait.src swaps hit cache instead of a first-time network fetch (see
// imagePreload.js). Never awaited - it doesn't block connecting to the
// server or anything else on the page.
preloadBattleImages();
// Same idea for every sound effect, music track, and voice line (see
// audioPreload.js) - so the first time any of them plays mid-match, it's
// already cached rather than waiting on a live fetch.
preloadBattleAudio();
connect();
rerender();
startMenuMusic();
