// Reactive per-character "action flash" portraits - reimplements the main
// game's dashboardScreen.js setXxx()/characterCard.js priority-chain system
// against the multiplayer server's action log instead of live client-side
// mutation. Same trigger conditions (see setter table extracted from the
// main game), same 1600ms flash duration, same idle/untouched-since-last-
// turn pattern for the 8 "idle portrait" characters.
import { v } from './assetVersion.js';

const FLASH_DURATION_MS = 1600;

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

function setFlash(characterId, src) {
  const existing = activeFlash.get(characterId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    activeFlash.delete(characterId);
    onFlashExpired();
  }, FLASH_DURATION_MS);
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
  if (character.id === 'velorya' && character.untargetable) return v('assets/images/velorya/hided.jpg');
  if (character.id === 'blade' && character.special?.rebirthUsed) return v('assets/images/blade/alive.jpg');
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
    if (src) setFlash(character.id, src);
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

// Processes one NEW log entry (already known not to have been seen before)
// and fires whatever flash(es) it implies. Call in log-append order.
export function handleLogEntryForFlash(entry, game) {
  const isKO = (id) => game.characters[id]?.isKO;

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

  if (entry.type !== 'attack' && entry.type !== 'special' && entry.type !== 'setup') return;
  const { characterId, actionId, dodged, amountDealt } = entry;
  if (isKO(characterId)) return;

  switch (actionId) {
    case 'divineRestore':
      setFlash(characterId, 'assets/images/athena/heal.jpg'); break;
    case 'glorySmash':
      setFlash(characterId, 'assets/images/tharox/glory.jpg'); break;
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
  setFlash(entry.targetCharacterId, 'assets/images/akyros/dodge.jpg');
}
