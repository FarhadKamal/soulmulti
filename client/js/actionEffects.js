// Reactive one-shot CSS animations on the character tile itself (as opposed
// to portraitFlash.js, which swaps the portrait IMAGE) - reimplements the
// main game's hit-flash/hard-shake/dodge-skew/claw-scratch/smoke-burst/
// revive-burst/divine-light effects from characterCard.js/dashboardScreen.js
// against the multiplayer server's action log. Same trigger conditions,
// same visual result; see css/style.css for the animations themselves.
const EFFECT_DURATION_MS = {
  hit: 700,
  shake: 500,
  dodge: 500,
  claw: 600,
  smoke: 1600,
  revive: 1300,
  divine: 1100,
};

// Per-character currently-active one-shot effects, keyed by characterId ->
// { effects: Set<'hit'|'shake'|'dodge'|'claw'|'smoke'|'revive'|'divine'>,
//   clawCount, timers: Map }. Multiple effects CAN overlap on one character
// (e.g. a killing Shadow Execution hit-flashes AND shakes AND claws all at
// once) - unlike portraitFlash's single active image, these are independent
// layers, matching the main game's separate flashCharacterIds/
// shakeCharacterIds/clawCharacterIds/etc. sets.
const activeEffects = new Map();

let onEffectExpired = () => {};
export function registerEffectRerender(fn) {
  onEffectExpired = fn;
}

function addEffect(characterId, effect, durationMs, clawCount) {
  let entry = activeEffects.get(characterId);
  if (!entry) {
    entry = { effects: new Set(), clawCount: 3, timers: new Map() };
    activeEffects.set(characterId, entry);
  }
  entry.effects.add(effect);
  if (effect === 'claw' && clawCount) entry.clawCount = clawCount;

  const existingTimer = entry.timers.get(effect);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    entry.effects.delete(effect);
    entry.timers.delete(effect);
    onEffectExpired();
  }, durationMs);
  entry.timers.set(effect, timer);
}

export function getActiveEffects(characterId) {
  return activeEffects.get(characterId)?.effects ?? new Set();
}

export function getClawCount(characterId) {
  return activeEffects.get(characterId)?.clawCount ?? 3;
}

// Applies the general "damage actually landed" hit-flash - same gate as the
// main game's markHitFromResult (amountDealt > 0 AND a target), covering
// every damaging ability uniformly rather than per-actionId. Deliberately
// NOT gated on the target's KO state - a killing blow should still flash
// (matches markHitFromResult, which only checks amountDealt > 0).
function applyHitFlash(targetCharacterId, amountDealt) {
  if (amountDealt > 0 && targetCharacterId) {
    addEffect(targetCharacterId, 'hit', EFFECT_DURATION_MS.hit);
  }
}

// Processes one NEW log entry and fires whatever tile effect(s) it implies.
// Call in log-append order, alongside handleLogEntryForFlash.
export function handleLogEntryForEffects(entry, game) {
  const isKO = (id) => game.characters[id]?.isKO;

  if (entry.type === 'dodge') {
    // Keyed on the DEFENDER, same as portraitFlash's akyros_dodge image.
    if (!isKO(entry.targetCharacterId)) addEffect(entry.targetCharacterId, 'dodge', EFFECT_DURATION_MS.dodge);
    return;
  }

  if (entry.type === 'rebirth') {
    if (!isKO(entry.targetCharacterId)) addEffect(entry.targetCharacterId, 'revive', EFFECT_DURATION_MS.revive);
    return;
  }

  // Jester Ball "Take": explodes on the holder (shake + smoke) UNLESS it
  // triggered Blade's Rebirth instead - that case already got its own
  // 'revive' effect from the rebirth entry above (which the server always
  // pushes right after this one when 'take' revives Blade), so skip the
  // explosion visuals to avoid stacking a shake/smoke burst on top of it.
  if (entry.type === 'jester-ball-take') {
    // Unlike every other trigger here, this one fires even if the
    // explosion itself just KO'd the holder (matches the main game, which
    // only gates the KO *sound* on isKO, not these visuals).
    if (!entry.revived) {
      addEffect(entry.targetCharacterId, 'shake', EFFECT_DURATION_MS.shake);
      addEffect(entry.targetCharacterId, 'smoke', EFFECT_DURATION_MS.smoke);
    }
    return;
  }

  // Athena's curse mirror is its own log-entry type (not 'attack'/
  // 'special') - still deserves the general hit-flash on whoever it landed
  // on, same as the main game's markHitFromResult recursing into
  // result.mirrorResult.
  if (entry.type === 'curse-mirror') {
    applyHitFlash(entry.toCharacterId, entry.amount);
    return;
  }

  if (entry.type !== 'attack' && entry.type !== 'special') return;
  const { characterId, actionId, targetId, dodged, amountDealt, streak, flip, outcome } = entry;

  applyHitFlash(targetId, amountDealt);

  // Self-buff golden glow: Divine Restore and Glory Smash both self-heal
  // the caster - only if the buff actually landed (caster not KO'd, same
  // "no misleading sparkle on a KO'd character" reasoning as the main game).
  if ((actionId === 'divineRestore' || actionId === 'glorySmash') && !isKO(characterId)) {
    addEffect(characterId, 'divine', EFFECT_DURATION_MS.divine);
  }

  // Cyclone Punch: shake on a heads flip that wasn't dodged.
  if (actionId === 'cyclonePunch' && flip === 'heads' && !dodged) {
    addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
  }

  // Chaos Gamble: shake on a 'win' roll that wasn't dodged.
  if (actionId === 'chaosGamble' && outcome === 'win' && !dodged) {
    addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
  }

  // Landed-hit shake: Titan Smash / Glory Smash hitting their target.
  if ((actionId === 'titanSmash' || actionId === 'glorySmash') && targetId && !dodged && amountDealt > 0) {
    addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
  }

  // Shadow Execution: shake + claw marks (always 3) on the target.
  if (actionId === 'shadowExecution' && targetId && !dodged && amountDealt > 0) {
    addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
    addEffect(targetId, 'claw', EFFECT_DURATION_MS.claw, 3);
  }

  // Blood Hunt: claw marks scaled to streak count, shake only once the
  // streak reaches 3+ (matches the main game's shakeCharacterIds.add gate).
  if (actionId === 'bloodHunt' && targetId && !dodged && amountDealt > 0) {
    const streakCount = streak || 1;
    if (streakCount >= 3) addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
    addEffect(targetId, 'claw', EFFECT_DURATION_MS.claw, streakCount);
  }
}
