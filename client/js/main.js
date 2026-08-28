import { connect, onMessage } from './net.js';
import { renderLobby } from './lobbyScreen.js';
import { renderBattle } from './battleScreen.js';
import { addChatMessage, clearChatMessages } from './chatPanel.js';
import {
  startMenuMusic, startBattleMusic, stopMusic,
  playActionSound, playSound, playKO, playVictory, playDodge, playRebirth, playCoin,
} from './sound.js';
import { handleLogEntryForFlash, handleDodgeForFlash, checkIdlePortrait, registerFlashRerender, queueGrimtalPowerFlash } from './portraitFlash.js';
import { handleLogEntryForEffects, registerEffectRerender } from './actionEffects.js';
import { preloadBattleImages } from './imagePreload.js';
import { preloadBattleAudio } from './audioPreload.js';
import { hasVoice, playIdleVoice, playInjuredVoice, playKoedVoice, playVictoryVoice, playMoveVoice, playLaughVoice, playRebirthVoice, playDraxusStrikeVoice } from './voice.js';

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
  // Mirrors awaitingSoulSwapWrath's pattern for Oraclus's own two-stage
  // Rune Vision cast - true from the moment he picks the predicted
  // ATTACKER through to picking the predicted TARGET. predictedAttackerId/
  // validRuneVisionTargets drive the stage-2 target picker panel.
  awaitingRuneVisionTarget: false,
  predictedAttackerId: null,
  validRuneVisionTargets: [],
  // Mirrors awaitingSoulSwapWrath's pattern for Melyssa's own two-stage
  // Mind Control flow - true from the moment she selects a puppet through
  // to the puppeted action (and any nested follow-up) fully resolving.
  // mindControlPuppetId is whichever character she's currently puppeting -
  // drives both the stage-2 action panel and the puppet's tile highlight.
  awaitingMindControlAction: false,
  mindControlPuppetId: null,
  armedAction: null,
  turnDeadline: null,
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
    // Draxus's death-proof floor (damagePipeline.js) can drop him to 1
    // heart while special.deathproofActive is true - his portrait
    // correctly stays on immortality.jpg the whole window (see
    // getPersistentPortrait in portraitFlash.js), but this heart-based
    // check has no such gate, so it would otherwise still fire his
    // "injured" voice line under the same hit. Skip it here to match.
    if (character.id === 'draxus' && character.special?.deathproofActive) continue;
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
// victory art, then finally the Match Over banner. ~1.2s + ~3.8s for a
// normal human match, same total as the main game's own two-stage delay.
// A bots4 spectacle room gets a longer reveal on both stages - nobody's
// waiting to take their next turn there, so there's no cost to lingering
// longer on the finishing hit and the victory art before cutting to the
// banner (which itself also gets a longer stay via BOT_SHOW_RESTART_DELAY_MS
// server-side - see index.js). Reported directly: the auto-looping bot
// show cut to the win screen too fast to actually enjoy the ending.
const GAME_OVER_FREEZE_MS = 1200;
const GAME_OVER_VICTORY_MS = 3800;
const BOT_SHOW_GAME_OVER_FREEZE_MS = 2500;
const BOT_SHOW_GAME_OVER_VICTORY_MS = 6000;
// Tharox's Earthshatter runs MUCH longer than every other action's flash/
// sound/voice (4.5s portrait, 5.2s sound effect - see portraitFlash.js's
// EARTHSHATTER_FLASH_DURATION_MS / sound.js's EARTHSHATTER_SOUND_LOCK_MS).
// If it happens to be the killing blow, the normal 1200ms freeze was
// cutting away to the victory screen while Earthshatter's own animation/
// audio were still very much mid-playback - confirmed live report ("i have
// seen wining image coming too first"). Matches the longer of its two
// durations so the freeze genuinely outlasts everything it triggered.
const EARTHSHATTER_GAME_OVER_FREEZE_MS = 5200;
function startGameOverSequence(game) {
  if (gameOverSequenceStarted) return;
  gameOverSequenceStarted = true;
  const isBotShow = state.room?.roomType === 'bots4';
  // finalizeAction (turnEngine.js) always appends an 'end-action' entry as
  // the very last thing in the log after any action resolves, carrying the
  // same actionId - if the finishing blow was Earthshatter, hold the
  // freeze stage long enough for its own effects to fully play out before
  // cutting to victory art.
  const wasEarthshatter = game.log[game.log.length - 1]?.actionId === 'earthshatter';
  const freezeMs = wasEarthshatter
    ? EARTHSHATTER_GAME_OVER_FREEZE_MS
    : (isBotShow ? BOT_SHOW_GAME_OVER_FREEZE_MS : GAME_OVER_FREEZE_MS);
  const victoryMs = isBotShow ? BOT_SHOW_GAME_OVER_VICTORY_MS : GAME_OVER_VICTORY_MS;
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
      // playVictoryVoice/hasVoice in voice.js) - a real bug this fixes:
      // heard Boingo's victory line despite Boingo being KO'd, because he
      // simply came first in characterIds and had a recorded voice -
      // Akyros, the actual survivor, was never checked.
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
    }, victoryMs);
  }, freezeMs);
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
// game/killerCharacterId are threaded through here (rather than each call
// site handling its own follow-ups) so the Grimtal power-surge hook below
// has exactly one place to live, covering all 4 koTriggered sites in this
// file (curse-mirror, mirror-reflect, jester-ball-take, generic attack/
// special) without duplicating the check at each of them.
function playKoedFor(characterId, game, killerCharacterId) {
  if (!playKoedVoice(characterId)) playKO();
  queueGrimtalPowerIfAlive(game, characterId, killerCharacterId);
}

// Grimtal's power.jpg/power.mp3 follow-up: per the Claim the Kill design,
// only a kill GRIMTAL HIMSELF personally lands auto-powers him - a kill
// someone else lands just banks as unclaimed (see claim_kill.jpg/mp3 for
// that separate, deliberately different moment, triggered from the
// claimKill action itself, not from here). killerCharacterId must be
// 'grimtal' for this to fire at all - a no-op for every other attacker,
// and a no-op if Grimtal isn't in this match, is already KO'd himself
// (checked here AND again inside queueGrimtalPowerFlash's own delayed
// timer, in case he dies during the delay window), or IS the character who
// just died (can't happen in practice since killerCharacterId === 'grimtal'
// already implies he's alive and attacking, but guarded for clarity).
function queueGrimtalPowerIfAlive(game, koedCharacterId, killerCharacterId) {
  const grimtal = game.characters.grimtal;
  if (!grimtal || grimtal.isKO || koedCharacterId === 'grimtal') return;
  if (killerCharacterId !== 'grimtal') return;
  queueGrimtalPowerFlash('grimtal', game);
  // Relative to right now (playKoedFor just started the koed voice playing)
  // rather than the original log-entry-processing moment - koed.mp3 runs
  // ~1.6s, so waiting that long here lets it fully finish before power.mp3
  // starts, same non-overlapping sequencing as before.
  setTimeout(() => playMoveVoice('grimtal', 'power'), 1600);
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
    // Grimtal's Grim Ward uses the magic_dodge sound (same file as Marin's
    // Threefold Veil discovery sound - see sound.js's ACTION_SOUND) instead
    // of the plain generic dodge sound everyone else gets, per explicit
    // request for a more distinct/weighty cue on his counter-dodge.
    if (entry.targetCharacterId === 'grimtal') playSound('magic_dodge.wav');
    // Illyra's passive uses its own dedicated illusion.mp3 sound, per
    // explicit request - distinct from both the plain generic dodge and
    // Grimtal's magic_dodge.wav.
    else if (entry.targetCharacterId === 'illyra') playSound('illusion.mp3');
    else playDodge();
    // Marin's Threefold Veil dodge gets its own spoken line on top of the
    // generic dodge sound - a no-op for Akyros's own dodge (same shared
    // 'dodge' entry type/shape, but he has no threefoldDodge line to look
    // up). See voice.js's ACTION_VOICE_LINES.marin comment for why this is
    // a separate key from threefoldVeil (that one's reserved for the
    // discovery moment, not the dodge itself).
    if (entry.targetCharacterId === 'marin' && !game.characters.marin?.isKO) {
      playMoveVoice('marin', 'threefoldDodge');
    }
    // Grimtal's Grim Ward, same reasoning as Marin's threefoldDodge above -
    // a spoken line on top of the generic dodge sound for this specific
    // dodge source only.
    if (entry.targetCharacterId === 'grimtal' && !game.characters.grimtal?.isKO) {
      playMoveVoice('grimtal', 'grimWard');
    }
    // Illyra's passive, same reasoning as Marin/Grimtal above - a spoken
    // line on top of her own dedicated dodge sound.
    if (entry.targetCharacterId === 'illyra' && !game.characters.illyra?.isKO) {
      playMoveVoice('illyra', 'dodge');
    }
    return;
  }
  if (entry.type === 'headache-roll') {
    // Grimtal's Skull Crack headache: only the actual SKIP outcome gets a
    // sound/tile animation - a roll that resolves with no skip is a non-
    // event visually (nothing was lost), same "only the consequential
    // outcome gets feedback" reasoning as chaosGamble's 'lose' branch below.
    if (entry.skipped) playSound('head_spin.mp3');
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
    // fromCharacterId is always 'athena' here (this is her curse mirror
    // specifically) - passed through anyway for correctness rather than
    // hardcoding a non-Grimtal marker, in case a future character adds a
    // similar mirror mechanic.
    if (entry.koTriggered) setTimeout(() => playKoedFor(entry.toCharacterId, game, entry.fromCharacterId), 200);
    return;
  }
  if (entry.type === 'mirror-reflect') {
    // Same reasoning as curse-mirror above - no dedicated sound of its
    // own, just the KO'd sound if the reflect happens to finish someone
    // off. The visible confirmation (hit-flash/shake) is handled in
    // actionEffects.js's handleLogEntryForEffects. fromCharacterId is
    // always 'rowan' here (this is his Mirror Reflect specifically).
    if (entry.koTriggered) setTimeout(() => playKoedFor(entry.toCharacterId, game, entry.fromCharacterId), 200);
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
  // The ball passing THROUGH Boingo mid-sequence (not the final landing) -
  // a smaller, quieter version of the full jester-ball-return beat above:
  // same coin/chime-style sound, but he still gets his laugh every single
  // time it lands on him (confirmed ruling - "he will laugh each time ball
  // landed on him"), not just the big payoff moments.
  if (entry.type === 'jester-ball-checkpoint-heal') {
    playCoin();
    playLaughVoiceIfAlive(entry.boingoId, game);
    return;
  }
  // Boingo choosing to sit on the ball for now - no sound of its own, it's
  // a quiet non-event (nothing about game state changed at all).
  if (entry.type === 'jester-ball-keep') {
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
      // A Jester Ball explosion is always attributed to whoever threw it
      // (only Boingo has this move) - can never be Grimtal's own kill, so
      // 'boingo' is passed explicitly here rather than a real lookup.
      if (entry.koTriggered) setTimeout(() => playKoedFor(entry.targetCharacterId, game, 'boingo'), 200);
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
  if (entry.type === 'mind-control-resist') {
    // The 50% chance her puppeted action simply fails - her own frustrated
    // reaction voice line, a no-op for anyone but Melyssa (only she has a
    // 'useless' line recorded).
    playMoveVoice(entry.characterId, 'resist');
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
  if (entry.type === 'prediction-result') {
    // Oraclus's Rune Vision resolving - its own dedicated log entry type
    // (server's resolveOraclusPredictionIfPending), not a player-picked
    // action, so it can't flow through the generic playActionSound
    // dispatch below either. matched decides win (triumphant chime) vs
    // miss (fizzle/shatter) - see correct.mp3/wrong.mp3.
    playSound(entry.matched ? 'correct' : 'wrong');
    playMoveVoice('oraclus', entry.matched ? 'runeVisionWin' : 'runeVisionLoss');
    return;
  }
  if (entry.type === 'ashka-heal') {
    // Kaelis's passive follow-up bird heal (Call Ashka's 2 free ticks) -
    // not a player-picked action, so it can't flow through the generic
    // playActionSound(entry.actionId) dispatch below (no actionId on this
    // entry type). The CAST turn's own heal (a real 'special' entry with
    // actionId: 'callAshka') already gets its sound via that generic path.
    playSound('bird_heal');
    // Same "thank you, Ashka" line as the cast itself (reuses
    // ACTION_VOICE_LINES.kaelis.callAshka via playMoveVoice's normal
    // actionId lookup) - she thanks the bird every time it actually heals
    // her, not just on the initial summon.
    playMoveVoice('kaelis', 'callAshka');
    return;
  }
  if (entry.type === 'spell-discovered') {
    // Rowan's own discoveries stay voice-silent (his spells are cast
    // separately later - the CAST is where his flash/voice/sound lives, not
    // the reveal). Marin's 5 spells auto-activate the instant they're
    // revealed - there is no later cast moment for any of them - so THIS is
    // the trigger point for 3 of the 5 (Threefold Veil, Piercing Wand,
    // Wand Mastery - simple "now active forever" announcements with no
    // separate first-use moment of their own). Everbloom and Clean Slate
    // are deliberately EXCLUDED here even though they're also Marin's -
    // Everbloom gets its own sound from its first everbloom-tick entry
    // (which can fire in this SAME broadcast, since onTurnStart both
    // reveals and immediately heals on the turn of discovery - a second
    // sound here would double up), and Clean Slate stays silent until it
    // actually fires later (clean-slate-trigger) - discovery just arms it,
    // nothing happened yet worth announcing.
    if (entry.characterId === 'marin' && entry.spellId
      && entry.spellId !== 'everbloom' && entry.spellId !== 'cleanSlate') {
      playActionSound(entry.spellId === 'piercingWand' || entry.spellId === 'wandMastery' ? 'wandDiscover' : entry.spellId);
      playMoveVoice('marin', entry.spellId);
    }
    return;
  }
  if (entry.type === 'everbloom-tick') {
    // Recurring, once per one of Marin's own turns for the rest of the
    // match once discovered - same "fires every time, not just once"
    // shape as Rowan's poison-tick, just self-targeted and healing instead
    // of damaging. The short sound effect plays on every single tick (kept
    // deliberately light - see sound.js's own 'everbloom' file), but the
    // spoken "Still blooming" voice line is reserved for the FIRST tick
    // only, matching how discovery's own voice line works for her other
    // passives - a full sentence repeating every turn for the rest of a
    // long match would wear out fast in a way the short chime doesn't.
    if (entry.healed > 0) {
      playActionSound('everbloom');
      if (entry.isFirstTick) playMoveVoice('marin', 'everbloom');
    }
    return;
  }
  if (entry.type === 'clean-slate-trigger') {
    playActionSound('cleanSlate');
    playMoveVoice('marin', 'cleanSlate');
    return;
  }
  if (entry.type !== 'attack' && entry.type !== 'special' && entry.type !== 'setup') return;

  // A dodged hit already got its own 'dodge' log entry (and playDodge()
  // above) - the ability's own attack/special entry still gets pushed
  // alongside it (with dodged:true, amountDealt 0), but per the main
  // game's playPostActionSounds, dodge and the normal action sound are
  // mutually exclusive, not layered.
  if (entry.dodged) return;

  // Rune Vision's sound/voice belongs to the CAST moment (stage 1) only -
  // stage 2 (predictedTargetId, entry.stage === 2) shares the same
  // actionId: 'runeVision' but is really just completing the same cast,
  // not a second distinct action - without this it would play the mystical
  // casting sound TWICE in quick succession for one prediction.
  if (entry.actionId === 'runeVision' && entry.stage === 2) return;
  if (entry.actionId === 'cyclonePunch') playCoin();
  if (entry.actionId === 'chaosGamble' && entry.outcome === 'lose') {
    playSound('miss');
    return;
  }
  // Marin's Arcane Study cast uses her own quiet notification sound
  // (silent_study.wav) rather than Rowan's shared book-page sound
  // (arcaneStudy -> 'study' in ACTION_SOUND) - ACTION_SOUND is a flat
  // actionId-keyed map with no per-character branching, so this one
  // shared action id needs an explicit override here instead.
  if (entry.actionId === 'arcaneStudy' && entry.characterId === 'marin') {
    playSound('silent_study.wav');
    playMoveVoice('marin', 'arcaneStudy');
    return;
  }
  // Oraclus's Rune Strike scales 1/2/3 damage as his prediction wins stack
  // (see oraclus.js) - the empowered 3-damage version gets its own heavier
  // impact sound, same "amountDealt decides which sound" override pattern
  // as this file's other manual cases. 2-damage (one win banked) still
  // uses the base sound - only the fully-empowered 3-damage hit is
  // distinct enough to warrant the stronger sound.
  if (entry.actionId === 'runeStrike' && entry.amountDealt >= 3) {
    playSound('rune_strike_strong');
    playMoveVoice('oraclus', 'runeStrikeStrong');
    return;
  }
  playActionSound(entry.actionId);
  // Layered on top of the effect sound just played above, never replacing
  // it (see voice.js's playMoveVoice) - a no-op for any character/action
  // that isn't one of the recorded signature moves so far. Kaelis's
  // grudgeStrike is the one exception: her line is reserved for an actual
  // revenge hit (amountDealt > 1, same signal the shake effect in
  // actionEffects.js already uses) - a plain baseline poke with nothing
  // owed stays silent rather than playing the same line every time.
  if (entry.actionId !== 'grudgeStrike' || entry.amountDealt > 1) {
    playMoveVoice(entry.characterId, entry.actionId);
  }
  // Draxus's 3 Deathless Fury bonus strikes each get their own One/Two/
  // Three line - can't use the generic playMoveVoice dispatch above since
  // that only supports one fixed filename per actionId, and both normal
  // and bonus dyingBlow hits share the same actionId. A normal (non-bonus)
  // Dying Blow stays voice-silent, same as Kaelis's baseline grudge hits.
  if (entry.actionId === 'dyingBlow' && entry.isBonusStrike) {
    playDraxusStrikeVoice(entry.strikeNumber);
  }
  // Grimtal's power.mp3 (queued from playKoedFor via queueGrimtalPowerIfAlive
  // below) plays only AFTER the koed victim's own koed.mp3 has fully
  // finished, not overlapping/arbitrated against it - koed fires at the
  // 200ms mark here and runs ~1.6s itself (matches power.jpg's own
  // FLASH_DURATION_MS-based delay in portraitFlash.js, so the voice and the
  // portrait swap land together).
  if (entry.koTriggered) setTimeout(() => playKoedFor(entry.targetCharacterId, game, entry.characterId), 200);
  // Illyra's Mirage Burst can KO multiple victims in the SAME detonation
  // (no single koTriggered/targetCharacterId at the top level like a
  // normal attack - see entry.bursts instead) - each one that died still
  // deserves its own koed voice/sound confirmation, same as any other KO.
  if (entry.actionId === 'mirageBurst') {
    for (const burst of entry.bursts || []) {
      if (burst.koTriggered) {
        setTimeout(() => playKoedFor(burst.targetId, game, entry.characterId), 200);
      }
    }
  }
  // Athena's Divine Sacrifice can KO HERSELF via its own separate self-cost
  // roll (entry.selfResult.koTriggered) - a distinct outcome from the enemy
  // target's own koTriggered above (both could even fire from the same
  // cast, in theory, though a dead Athena wouldn't be dealing the enemy hit
  // in the first place - the ordering inside her execute() means her own
  // death is resolved AFTER the enemy hit, so this is the realistic case).
  // Without this, her own KO from this move would have no voice/sound
  // confirmation at all.
  if (entry.actionId === 'divineSacrifice' && entry.selfResult?.koTriggered) {
    setTimeout(() => playKoedFor(entry.characterId, game, entry.characterId), 200);
  }
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
      state.awaitingRuneVisionTarget = !!msg.awaitingRuneVisionTarget;
      state.predictedAttackerId = msg.predictedAttackerId ?? null;
      state.validRuneVisionTargets = msg.validRuneVisionTargets || [];
      state.awaitingMindControlAction = !!msg.awaitingMindControlAction;
      state.mindControlPuppetId = msg.mindControlPuppetId ?? null;
      state.armedAction = null;
      state.turnDeadline = msg.turnDeadline || null;
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
      // entry screen (create/join), same connection stays open.
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
    case 'unseated':
      // The room owner moved this player's seat to Guest status directly
      // (see handleUnseatPlayer in index.js) - unlike a full room exit,
      // they STAY in the room, just as a Guest now (a 'lobby-update'
      // reflecting that new status is broadcast right alongside this and
      // will arrive separately) - just a brief notice so it reads as a
      // deliberate host action, not a random bug.
      state.error = 'The host moved you to Guest.';
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
