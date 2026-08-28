// Reactive per-character "action flash" portraits - reimplements the main
// game's dashboardScreen.js setXxx()/characterCard.js priority-chain system
// against the multiplayer server's action log instead of live client-side
// mutation. Same trigger conditions (see setter table extracted from the
// main game), same 1600ms flash duration, same idle/untouched-since-last-
// turn pattern for the 8 "idle portrait" characters.
import { v } from './assetVersion.js';

const FLASH_DURATION_MS = 1600;

// Tharox's Earthshatter portrait stays up much longer than the normal
// 1600ms every other flash uses - confirmed ruling: the image shouldn't
// revert back to idle while the ground-shattering sound effect (~5.2s, see
// sound.js's EARTHSHATTER_SOUND_LOCK_MS) is still playing out. 4.5s rather
// than the sound's own full length, per explicit choice.
const EARTHSHATTER_FLASH_DURATION_MS = 4500;

// Grimtal's power.jpg follow-up: fires AFTER his own strike flash has fully
// finished playing (not simultaneously), same "let the first beat read
// before the second starts" sequencing Rowan's mirror-shard effect uses
// (see actionEffects.js's MIRROR_SEQUENCE_DELAY_MS) - here the gap is the
// full FLASH_DURATION_MS itself, since the thing being sequenced IS another
// portrait flash sharing this exact same timer/slot.
const GRIMTAL_POWER_DELAY_MS = FLASH_DURATION_MS;

// Per-character currently-flashing image path, cleared after
// FLASH_DURATION_MS. Keyed by characterId (not a Set, since only one flash
// image can show per character at a time - a later flash simply overwrites
// an earlier one, matching the main game's priority chain naturally
// collapsing to "whichever fired most recently").
const activeFlash = new Map(); // characterId -> { src, timer }
// Tracks each idle-portrait character's hearts as of their last turn start,
// to detect "untouched since last turn" - same reasoning as
// athenaHeartsAtLastTurnStart etc. in the main game.
const heartsAtLastTurnStart = new Map(); // characterId -> number | null

// The flash's own expiry timer doesn't get a fresh server broadcast to
// trigger a re-render off of (the server has no idea this is a purely
// client-side, timed visual effect) - main.js registers its rerender()
// here once at startup so the portrait actually reverts when the flash
// duration elapses, same as the main game's own setXxx() calling render()
// inside its setTimeout.
let onFlashExpired = () => {};
export function registerFlashRerender(fn) {
  onFlashExpired = fn;
}

function setFlash(characterId, src, durationMs = FLASH_DURATION_MS) {
  const existing = activeFlash.get(characterId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    activeFlash.delete(characterId);
    onFlashExpired();
  }, durationMs);
  activeFlash.set(characterId, { src, timer });
}

export function getFlashSrc(characterId) {
  const src = activeFlash.get(characterId)?.src ?? null;
  return src ? v(src) : null;
}

// Two persistent (non-timed) portrait overrides, checked directly against
// live character state rather than the log - same priority position as the
// main game's characterCard.js (both sit below every timed flash, above
// the KO/injured/default fallback): Velorya's hidden/eclipsed look while
// untargetable, and Blade's "back from the dead" look for the rest of the
// match once Rebirth has triggered.
export function getPersistentPortrait(character) {
  if (character.isKO) return null;
  // Held for the entire duration of a Mind Control sequence (from puppet
  // selection through the puppeted action and any nested follow-up) -
  // character.special.controlling is real, serialized character state, set
  // by melyssa.js's own mindControl.execute() and cleared by
  // finishMelyssaTurn (server/index.js) once the whole sequence resolves.
  if (character.id === 'melyssa' && character.special?.controlling) return v('assets/images/melyssa/mind_control_selection.jpg');
  if (character.id === 'velorya' && character.untargetable) return v('assets/images/velorya/hided.jpg');
  if (character.id === 'blade' && character.special?.rebirthUsed) return v('assets/images/blade/alive.jpg');
  // Held from the moment Deathless Fury is cast until his own next
  // onTurnStart clears deathproofActive (draxus.js) - persists across
  // however many intervening turns the death-proof window spans, same
  // "real serialized state, not a client timer" pattern as Melyssa's own
  // held portrait above.
  if (character.id === 'draxus' && character.special?.deathproofActive) return v('assets/images/draxus/immortality.jpg');
  return null;
}

// Every character's idle/untouched portrait, keyed by id - the 8 "own turn
// started, took no damage since last turn, above half health" flashes.
const IDLE_IMAGE = {
  athena: 'assets/images/athena/apple.jpg',
  velorya: 'assets/images/velorya/dance.jpg',
  boingo: 'assets/images/boingo/circus.jpg',
  zerathys: 'assets/images/zerathys/glass.jpg',
  tharox: 'assets/images/tharox/roar.jpg',
  blade: 'assets/images/blade/guitar.jpg',
  chronox: 'assets/images/chronox/space.jpg',
  akyros: 'assets/images/akyros/rose.jpg',
  melyssa: 'assets/images/melyssa/chess.jpg',
  kaelis: 'assets/images/kaelis/idle.jpg',
  draxus: 'assets/images/draxus/idle.jpg',
  rowan: 'assets/images/rowan/idle.jpg',
  marin: 'assets/images/marin/idle.jpg',
  grimtal: 'assets/images/grimtal/idle.jpg',
  illyra: 'assets/images/illyra/idle.jpg',
  oraclus: 'assets/images/oraclus/idle.jpg',
};

// Per-character idle-flash duration overrides (falls back to the shared
// FLASH_DURATION_MS for everyone not listed here). Grimtal's flute-playing
// idle image is a quieter character beat meant to linger longer than a
// normal 1.6s flash - per explicit request, held roughly double that.
const IDLE_DURATION_MS = {
  grimtal: 3000,
};

// Call once per character at the moment their own turn starts (i.e. when
// they first appear as actingCharacterId after not having been the actor
// on the previous broadcast) - see main.js's turn-start edge detection.
// Returns true if the character was genuinely in the "idle" state
// (untouched since last turn, above half health) - main.js uses this same
// boolean to decide whether to also play that character's idle voice line
// (voice.js's playIdleVoice), so there's exactly one definition of "idle"
// shared by both the portrait and the voice line, not two separately
// maintained checks that could drift apart.
export function checkIdlePortrait(character) {
  if (character.isKO) return false;
  // Draxus's persistent immortality.jpg portrait (getPersistentPortrait
  // above) must never get stomped by a timed idle flash - setFlash's
  // activeFlash entries sit ABOVE the persistent-portrait check in
  // battleScreen.js's render priority, so an idle flash firing during his
  // death-proof window would incorrectly hide the immortal portrait for
  // its whole duration. Skip idle entirely while it's active.
  if (character.id === 'draxus' && character.special?.deathproofActive) return false;
  const lastHearts = heartsAtLastTurnStart.has(character.id) ? heartsAtLastTurnStart.get(character.id) : null;
  const wasUntouched = lastHearts === null || character.hearts >= lastHearts;
  const isIdle = wasUntouched && character.hearts > character.maxHearts / 2;
  // Don't stomp a more specific flash that was JUST set for this same
  // broadcast (e.g. Akyros dodging the hit that ended up rotating turn
  // order straight to him - handleDodgeForFlash's akyros_dodge flash and
  // this idle-rose check both fire from the same game-state message, and
  // without this guard the idle check (called second, from main.js) would
  // silently overwrite the dodge portrait before it was ever rendered,
  // in the same synchronous tick). The main game avoids this entirely by
  // using separate boolean flags with dodge checked ahead of idle in its
  // own if/else chain - this activeFlash map has no such built-in
  // priority, so it has to be enforced here instead.
  if (activeFlash.has(character.id)) {
    heartsAtLastTurnStart.set(character.id, character.hearts);
    return false;
  }
  if (isIdle) {
    const src = IDLE_IMAGE[character.id];
    if (src) setFlash(character.id, src, IDLE_DURATION_MS[character.id]);
  }
  heartsAtLastTurnStart.set(character.id, character.hearts);
  return isIdle;
}

// Boingo's "laughing" flash is the odd one out - triggered on the THROWER
// (thrownByCharacterId), not the acting character, from two different
// Jester Ball resolution outcomes (ball explodes on someone else, or gets
// returned to him) rather than from Boingo's own turn.
function handleLaughing(entry, game) {
  const thrownById = entry.type === 'jester-ball-take' ? findThrowerFor() : entry.boingoId;
  if (!thrownById) return;
  const thrower = game.characters[thrownById];
  if (!thrower || thrower.isKO) return;
  setFlash(thrownById, 'assets/images/boingo/laughing.jpg');
}

// jester-ball-take entries don't carry the original thrower's id directly
// in the broadcast log shape (the holder who took it is targetCharacterId,
// and by the time this entry is processed game.jesterBall has already been
// cleared to null) - so the thrower is tracked separately from the moment
// they cast jesterBall, for the life of that one throw.
let lastJesterBallThrowerId = null;
function findThrowerFor() {
  return lastJesterBallThrowerId;
}

// Grimtal's power.jpg: queued (not fired immediately) whenever ANY
// character on the board gets KO'd (his own damage now scales off the
// total KO count, not just kills he personally lands) - the caller
// (main.js's queueGrimtalPowerIfAlive) already checks he's alive and isn't
// the one who died before calling this. Delayed so it plays strictly AFTER
// whatever strike/flash is already showing has fully finished, not layered
// on top of it. game is captured via closure at call time rather than
// passed through the timer so a stale isKO check can't read from an
// outdated snapshot.
export function queueGrimtalPowerFlash(characterId, game) {
  setTimeout(() => {
    if (!game.characters[characterId]?.isKO) setFlash(characterId, 'assets/images/grimtal/power.jpg');
    onFlashExpired();
  }, GRIMTAL_POWER_DELAY_MS);
}

// Processes one NEW log entry (already known not to have been seen before)
// and fires whatever flash(es) it implies. Call in log-append order.
export function handleLogEntryForFlash(entry, game) {
  const isKO = (id) => game.characters[id]?.isKO;

  // Self Choke gets its own dedicated flash on Melyssa herself - checked
  // first and returns, since its entry's characterId is already 'melyssa'
  // directly (she's the true actor, per server/index.js's executeSelfChoke)
  // and must not ALSO trigger the generic controllingMelyssaId flash below.
  if (entry.actionId === 'selfChoke' && entry.characterId === 'melyssa') {
    if (!isKO('melyssa')) setFlash('melyssa', 'assets/images/melyssa/self_choke.jpg');
    return;
  }
  // The 50% chance her puppeted action simply fails - her own frustrated
  // reaction flash, checked BEFORE the generic controllingMelyssaId block
  // below (same early-return shape as Self Choke above), since this entry
  // also carries controllingMelyssaId and would otherwise get overwritten
  // by the generic mind_control_action.jpg flash instead.
  if (entry.type === 'mind-control-resist') {
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/melyssa/useless.jpg');
    return;
  }
  // Any puppeted action (real or a forced Jester Ball take/pass) additionally
  // flashes Melyssa's own portrait the instant it resolves - the puppet's
  // own portrait still separately flashes for the SAME entry via the
  // switch below (different characterIds in the activeFlash map, both
  // coexist). controllingMelyssaId is stamped server-side by
  // executeActionAsPuppet (turnEngine.js) onto every log entry a puppeted
  // action produces.
  if (entry.controllingMelyssaId && !isKO(entry.controllingMelyssaId)) {
    setFlash(entry.controllingMelyssaId, 'assets/images/melyssa/mind_control_action.jpg');
  }

  if (entry.type === 'special' && entry.actionId === 'jesterBall') {
    lastJesterBallThrowerId = entry.characterId;
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/boingo/throwing.jpg');
    return;
  }
  if (entry.type === 'jester-ball-return') {
    handleLaughing(entry, game);
    return;
  }
  if (entry.type === 'jester-ball-take') {
    // Explodes on someone OTHER than Boingo - flash the thrower laughing,
    // per the main game's reasoning ("his mischief paid off either way").
    if (entry.targetCharacterId !== lastJesterBallThrowerId) handleLaughing(entry, game);
    return;
  }
  if (entry.type === 'hidden-mark') {
    // Akyros's own ability logs a dedicated 'hidden-mark' entry (never
    // 'attack'/'special'/'setup') rather than folding into the generic
    // switch below - matches the main game, which fires this flash
    // straight off the executed actionId rather than a log-entry type.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/akyros/hidden.jpg');
    return;
  }
  if (entry.type === 'curse') {
    // Athena's Curse Strike also logs its own dedicated type (never
    // 'attack'/'special'/'setup') - same reasoning as hidden-mark above.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/athena/curse.jpg');
    return;
  }
  if (entry.type === 'prediction-result') {
    // Oraclus's Rune Vision resolving - its own dedicated log entry type
    // (server's resolveOraclusPredictionIfPending), same reasoning as
    // hidden-mark/curse above. Win and miss get visually distinct images
    // (see the win_prediction.jpg/loss_prediction.jpg design), unlike
    // every other flash pair in this file which all reuse ONE image with
    // different animation overlays for success/failure.
    if (!isKO('oraclus')) {
      setFlash('oraclus', entry.matched ? 'assets/images/oraclus/win_prediction.jpg' : 'assets/images/oraclus/loss_prediction.jpg');
    }
    return;
  }
  if (entry.type === 'ashka-heal') {
    // Kaelis's passive follow-up bird heal (Call Ashka's 2 free ticks) -
    // its own dedicated type, same reasoning as hidden-mark/curse above,
    // since it's not player-triggered and never carries an actionId.
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/kaelis/bird.jpg');
    return;
  }
  if (entry.type === 'spell-discovered') {
    // Marin's 5 spells auto-activate the instant they're revealed - unlike
    // Rowan (whose discoveries stay flash-silent, since HIS spells are cast
    // separately later - that later cast is where his own flash lives),
    // this dedicated type IS the one moment worth flashing for 3 of her 5
    // (Threefold Veil, Piercing Wand, Wand Mastery). Everbloom/Clean Slate
    // are excluded here for the same reasoning as their sound handling in
    // main.js - Everbloom gets its flash from its own first tick instead
    // (can fire in this same broadcast, would double up), Clean Slate stays
    // silent/unflashed until it actually fires later.
    if (entry.characterId === 'marin' && !isKO('marin')) {
      // Threefold Veil's discovery gets its OWN dedicated image
      // (threefold_discovery.jpg - calm, eyes closed, the ward settling
      // into place) rather than reusing threefold.jpg (an active dodge in
      // motion) - both used to share one image, which made a discovery
      // announcement visually indistinguishable from a real dodge and led
      // directly to a live miscount report ("saw 4 dodges" when only 3
      // charges/real dodges had actually happened - one of the 4 was this
      // discovery flash).
      const MARIN_DISCOVERY_FLASH = {
        threefoldVeil: 'assets/images/marin/threefold_discovery.jpg',
        piercingWand: 'assets/images/marin/piercing_wand.jpg',
        wandMastery: 'assets/images/marin/wand_mastery.jpg',
      };
      const src = MARIN_DISCOVERY_FLASH[entry.spellId];
      if (src) setFlash('marin', src);
    }
    return;
  }
  if (entry.type === 'everbloom-tick') {
    // Recurring - re-fires every one of Marin's own turns for the rest of
    // the match once discovered, same "not just a one-shot cast flash"
    // shape as Rowan's Poison Cloud tile effect re-firing every damage
    // tick (see actionEffects.js's own poison-tick handling for the
    // client-side precedent this follows).
    if (entry.healed > 0 && !isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/marin/everbloom.jpg');
    return;
  }
  if (entry.type === 'clean-slate-trigger') {
    if (!isKO(entry.characterId)) setFlash(entry.characterId, 'assets/images/marin/clean_slate.jpg');
    return;
  }

  if (entry.type !== 'attack' && entry.type !== 'special' && entry.type !== 'setup') return;
  const { characterId, actionId, dodged, amountDealt } = entry;
  if (isKO(characterId)) return;

  switch (actionId) {
    case 'divineRestore':
      setFlash(characterId, 'assets/images/athena/heal.jpg'); break;
    case 'divineSacrifice':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/athena/sacrifice.jpg');
      break;
    case 'glorySmash':
      setFlash(characterId, 'assets/images/tharox/glory.jpg'); break;
    case 'earthshatter':
      setFlash(characterId, 'assets/images/tharox/final.jpg', EARTHSHATTER_FLASH_DURATION_MS); break;
    case 'titanToss':
      setFlash(characterId, 'assets/images/tharox/toss.jpg'); break;
    case 'smash': case 'titanSmash':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/tharox/smash.jpg');
      break;
    case 'soulSwap':
      setFlash(characterId, 'assets/images/zerathys/soul.jpg'); break;
    case 'chargeUp':
      setFlash(characterId, 'assets/images/zerathys/charge.jpg'); break;
    case 'thunderWrath': case 'soulSwapWrath':
      if (!dodged) setFlash(characterId, 'assets/images/zerathys/strike.jpg');
      break;
    case 'timeFreeze':
      setFlash(characterId, 'assets/images/chronox/time.jpg'); break;
    case 'rewind':
      setFlash(characterId, 'assets/images/chronox/rewind.jpg'); break;
    case 'cyclonePunch':
      if (!dodged) setFlash(characterId, 'assets/images/chronox/cyclone.jpg');
      break;
    case 'shadowExecution':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/akyros/shadow.jpg');
      break;
    case 'fatalSlash':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/akyros/fatal.jpg');
      break;
    case 'lunarEclipse':
      setFlash(characterId, 'assets/images/velorya/casting.jpg'); break;
    case 'lunarStrike': case 'moonstep':
      if (!dodged) setFlash(characterId, 'assets/images/velorya/strike.jpg');
      break;
    case 'bloodHunt':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/blade/strike.jpg');
      break;
    case 'grudgeStrike':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/kaelis/grudge.jpg');
      break;
    case 'callAshka':
      setFlash(characterId, 'assets/images/kaelis/bird.jpg'); break;
    case 'dyingBlow':
      // Bonus-turn strikes (during his Deathless Fury payoff) flash a
      // distinct immortal_strike image, layered on top of his persistent
      // immortality.jpg portrait (getPersistentPortrait above) - a normal
      // turn's single strike flashes normal_strike instead. Both share
      // this one actionId/execute(), so the distinction has to come from
      // the log entry's own isBonusStrike flag (draxus.js), not the
      // action id itself.
      if (!dodged && amountDealt > 0) {
        setFlash(characterId, entry.isBonusStrike ? 'assets/images/draxus/immortal_strike.jpg' : 'assets/images/draxus/normal_strike.jpg');
      }
      break;
    case 'deathlessFury':
      // Cast-moment flash briefly reinforces the same image the
      // persistent override (getPersistentPortrait) then holds.
      setFlash(characterId, 'assets/images/draxus/immortality.jpg'); break;
    case 'chaosGamble':
      // 'lose' always flashes the miss portrait regardless of dodged (a
      // 0-damage roll can still report dodged:true against Akyros's first
      // hit) - matches the main game, which has no dodge guard on this
      // branch. 'win'/'draw' stay dodge-gated since those rolls deal real
      // damage that Akyros can actually dodge.
      if (entry.outcome === 'lose') setFlash(characterId, 'assets/images/boingo/miss.jpg');
      else if (!dodged) {
        if (entry.outcome === 'win') setFlash(characterId, 'assets/images/boingo/hardpunch.jpg');
        else if (entry.outcome === 'draw') setFlash(characterId, 'assets/images/boingo/normalpunch.jpg');
      }
      break;
    case 'wandStrike':
      // Shared action id (Rowan and Marin both have a Wand Strike) - the
      // image folder differs per character, everything else about the
      // trigger condition is identical.
      if (!dodged && amountDealt > 0) {
        setFlash(characterId, characterId === 'marin' ? 'assets/images/marin/wand_strike.jpg' : 'assets/images/rowan/wand_strike.jpg');
      }
      break;
    case 'arcaneStudy':
      // Same shared-action-id reasoning as wandStrike above.
      setFlash(characterId, characterId === 'marin' ? 'assets/images/marin/arcane_study.jpg' : 'assets/images/rowan/arcane_study.jpg');
      break;
    case 'poisonCloud':
      setFlash(characterId, 'assets/images/rowan/poison_cloud.jpg'); break;
    case 'purify':
      setFlash(characterId, 'assets/images/rowan/purify.jpg'); break;
    case 'wildLightning':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/rowan/wild_lightning.jpg');
      break;
    case 'mirrorReflect':
      setFlash(characterId, 'assets/images/rowan/mirror_reflect.jpg'); break;
    case 'silenceLock':
      setFlash(characterId, 'assets/images/rowan/silence_lock.jpg'); break;
    case 'grimStrike':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/grimtal/normal_attack.jpg');
      break;
    case 'skullCrack':
      if (!dodged && amountDealt > 0) setFlash(characterId, 'assets/images/grimtal/skull_crack.jpg');
      break;
    case 'claimKill':
      setFlash(characterId, 'assets/images/grimtal/claim_kill.jpg'); break;
    case 'mirageMark':
      setFlash(characterId, 'assets/images/illyra/mirage_mark.jpg'); break;
    case 'mirageBurst':
      // Always flashes on cast, regardless of amountDealt - unlike a
      // normal attack, this can never be dodged (ignoresDodge: true is
      // always set server-side), so the detonation itself always visibly
      // happens even if the target's shield ends up absorbing all of it.
      setFlash(characterId, 'assets/images/illyra/mirage_burst.jpg'); break;
    case 'mirageOverload':
      setFlash(characterId, 'assets/images/illyra/mirage_overload.jpg'); break;
    case 'runeStrike':
      // Empowered (3 damage, both prediction wins banked) gets its own
      // more intense flash image, same amountDealt-gated swap the sound/
      // voice already do (see main.js).
      if (!dodged && amountDealt > 0) {
        setFlash(characterId, amountDealt >= 3 ? 'assets/images/oraclus/rune_strong_strike.jpg' : 'assets/images/oraclus/rune_strike.jpg');
      }
      break;
    case 'runeVision':
      // Fires on stage 1 (the cast) only - stage 2 (entry.stage === 2,
      // picking the predicted target) is a plain data completion of the
      // same cast, not a second visible moment worth re-flashing.
      if (entry.stage === 1) setFlash(characterId, 'assets/images/oraclus/rune_prediction.jpg');
      break;
    default:
      break;
  }
}

// 'dodge' is its own log entry type (see damagePipeline.js), keyed on the
// DEFENDER, not the actor - handled separately from the switch above.
export function handleDodgeForFlash(entry, game) {
  if (entry.type !== 'dodge') return;
  const target = game.characters[entry.targetCharacterId];
  if (!target || target.isKO) return;
  // Shared log entry type/shape (damagePipeline.js's applyDamage pushes the
  // same 'dodge' entry for Akyros's per-attacker dodge, Marin's Threefold
  // Veil flat 3-charge pool, Grimtal's Grim Ward, AND Illyra's passive) -
  // the image differs per character, same reasoning as wandStrike/
  // arcaneStudy's shared-action-id branching below in this file.
  const src = target.id === 'marin' ? 'assets/images/marin/threefold.jpg'
    : target.id === 'grimtal' ? 'assets/images/grimtal/dodge.jpg'
    : target.id === 'illyra' ? 'assets/images/illyra/illusion.jpg'
    : 'assets/images/akyros/dodge.jpg';
  setFlash(target.id, src);
}
