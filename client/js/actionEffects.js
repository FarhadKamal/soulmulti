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
  crack: 600,
  bigshatter: 700,
  pow: 750,
  vortex: 650,
  axechop: 550,
  eyeburst: 750,
  tendrils: 1000,
  invertflash: 350,
  lightning: 500,
  choke: 700,
  smoke: 1600,
  revive: 1300,
  divine: 1100,
};

// Per-character currently-active one-shot effects, keyed by characterId ->
// { effects: Set<'hit'|'shake'|'dodge'|'claw'|'crack'|'pow'|'vortex'|
//   'axechop'|'smoke'|'revive'|'divine'>, clawCount, crackCount, powSize,
//   vortexSize, axechopTier, timers: Map }. Multiple effects CAN overlap on
// one character (e.g. a killing Shadow Execution hit-flashes AND shakes AND
// claws all at once) - unlike portraitFlash's single active image, these
// are independent layers, matching the main game's separate
// flashCharacterIds/shakeCharacterIds/clawCharacterIds/etc. sets.
const activeEffects = new Map();

let onEffectExpired = () => {};
export function registerEffectRerender(fn) {
  onEffectExpired = fn;
}

function addEffect(characterId, effect, durationMs, param) {
  let entry = activeEffects.get(characterId);
  if (!entry) {
    entry = { effects: new Set(), clawCount: 3, crackCount: 1, powSize: 'small', vortexSize: 'small', axechopTier: 1, lightningTier: 1, timers: new Map() };
    activeEffects.set(characterId, entry);
  }
  entry.effects.add(effect);
  if (effect === 'claw' && param) entry.clawCount = param;
  if (effect === 'crack' && param) entry.crackCount = param;
  if (effect === 'pow' && param) entry.powSize = param;
  if (effect === 'vortex' && param) entry.vortexSize = param;
  if (effect === 'axechop' && param) entry.axechopTier = param;
  if (effect === 'lightning' && param) entry.lightningTier = param;

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

export function getPowSize(characterId) {
  return activeEffects.get(characterId)?.powSize ?? 'small';
}

export function getAxechopTier(characterId) {
  return activeEffects.get(characterId)?.axechopTier ?? 1;
}

export function getLightningTier(characterId) {
  return activeEffects.get(characterId)?.lightningTier ?? 1;
}

export function getVortexSize(characterId) {
  return activeEffects.get(characterId)?.vortexSize ?? 'small';
}

export function getCrackCount(characterId) {
  return activeEffects.get(characterId)?.crackCount ?? 1;
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

  // Jester Ball returning to Boingo heals him - same self-buff golden glow
  // as Divine Restore/Glory Smash below, just triggered from its own log
  // entry type rather than 'attack'/'special'. Only when it actually
  // healed (not already full/KO'd), same "no misleading sparkle" guard.
  if (entry.type === 'jester-ball-return') {
    if (entry.healed > 0 && !entry.wasKO) addEffect(entry.boingoId, 'divine', EFFECT_DURATION_MS.divine);
    return;
  }

  // Athena's Curse Strike: a big eye-flash burst on the TARGET the instant
  // the curse takes hold - a scaled-up version of the existing pulsing 👁
  // icon (cursed-mark, style.css) with a radial purple shockwave ring, so
  // it reads as "the same eye that will now watch them" rather than a
  // generic unrelated impact mark. Distinct motion from every other
  // effect: snap-in-huge-then-shrink, not radiate/spin/pop/slam. Layered
  // with curling curse-tendrils that snake outward and wrap partway around
  // the tile edge right after the flash - an organic curling motion (vines/
  // smoke reaching out and gripping), extending the flash-instant into a
  // "taking hold" beat, still the same purple palette.
  if (entry.type === 'curse') {
    // Server pushes this as { type: 'curse', characterId, targetId } (see
    // athena.js's curseStrike.execute) - targetId, not targetCharacterId.
    if (!isKO(entry.targetId)) {
      addEffect(entry.targetId, 'eyeburst', EFFECT_DURATION_MS.eyeburst);
      addEffect(entry.targetId, 'tendrils', EFFECT_DURATION_MS.tendrils);
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
  const { characterId, actionId, targetId, dodged, amountDealt, streak, flip, outcome, grudgeCount } = entry;

  applyHitFlash(targetId, amountDealt);

  // Self-buff golden glow: Divine Restore and Glory Smash both self-heal
  // the caster - only if the buff actually landed (caster not KO'd, same
  // "no misleading sparkle on a KO'd character" reasoning as the main game).
  if ((actionId === 'divineRestore' || actionId === 'glorySmash') && !isKO(characterId)) {
    addEffect(characterId, 'divine', EFFECT_DURATION_MS.divine);
  }

  // Soul Swap: a quick color-invert flash directly on the VICTIM's own
  // portrait (photo-negative look, snapping back to normal) - reads as
  // "something was yanked out of you," matching the swap mechanic (their
  // hearts literally trade places with Zerathys's) rather than reusing any
  // damage/heal impact language, since this isn't damage at all. No isKO
  // guard needed beyond the usual - a swap can leave either side at very
  // low hearts but never KOs on its own.
  if (actionId === 'soulSwap' && targetId && !isKO(targetId)) {
    addEffect(targetId, 'invertflash', EFFECT_DURATION_MS.invertflash);
  }

  // Thunder Wrath (and Soul Swap Wrath, which delegates straight into this
  // same execute() and logs the identical actionId - one trigger covers
  // both automatically): a jagged lightning-bolt strike flashing down onto
  // the target, distinct from every other effect (nothing else does a
  // literal bolt). Scales with amountDealt (his charge-tier damage, 1/2/3):
  // tier 1 = single thin bolt; tier 3 = branching bolts plus shake, echoing
  // how his charge-up payoff should feel like the biggest hit in the kit.
  if (actionId === 'thunderWrath' && targetId && !dodged && amountDealt > 0) {
    addEffect(targetId, 'lightning', EFFECT_DURATION_MS.lightning, amountDealt);
    if (amountDealt === 3) addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
  }

  // Self Choke: a constricting violet ring closes in around the puppet's
  // OWN portrait (the "victim" here is the puppet Melyssa is forcing to
  // hurt themselves, not an enemy she struck directly - targetId is the
  // puppet, per server/index.js's executeSelfChoke). A contracting loop
  // that snaps shut, distinct from every other effect's expanding/
  // radiating/spinning-outward motion - reads as an invisible grip
  // tightening, matching her mind-control/puppet-strings theme. Always
  // deals exactly 1 unshielded damage per executeSelfChoke, so no dodge/
  // amount gating needed beyond confirming it actually landed.
  if (actionId === 'selfChoke' && targetId && amountDealt > 0) {
    addEffect(targetId, 'choke', EFFECT_DURATION_MS.choke);
  }

  // Cyclone Punch: a spinning violet vortex ring on any landed hit, reading
  // as temporal/cosmic energy rather than a physical impact mark (matches
  // his time/space theme, distinct from every other character's punch/claw/
  // crack language). Tails (1 dmg) gets a single small quick-spin ring;
  // heads (2 dmg, also shakes) gets a bigger ring plus a second inner ring
  // counter-spinning for a more chaotic "cyclone" feel.
  if (actionId === 'cyclonePunch' && !dodged && amountDealt > 0) {
    if (flip === 'heads') {
      addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
      addEffect(targetId, 'vortex', EFFECT_DURATION_MS.vortex, 'big');
    } else {
      addEffect(targetId, 'vortex', EFFECT_DURATION_MS.vortex, 'small');
    }
  }

  // Chaos Gamble: shake on a 'win' roll that wasn't dodged. Also a comic-
  // book "POW!"/"BAM!" text burst on any roll that actually connects (win
  // or draw, never 'lose' - that's a miss, nothing lands) - bigger text +
  // motion lines on a win, a smaller plain burst on a draw. Matches
  // Boingo's clownish theme instead of reusing the crack/claw impact
  // language every other character uses.
  if (actionId === 'chaosGamble' && !dodged) {
    if (outcome === 'win') {
      addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
      addEffect(targetId, 'pow', EFFECT_DURATION_MS.pow, 'big');
    } else if (outcome === 'draw') {
      addEffect(targetId, 'pow', EFFECT_DURATION_MS.pow, 'small');
    }
  }

  // Landed-hit shake: Titan Smash / Glory Smash hitting their target. These
  // two also get one big, centered radial shatter burst - a bigger, denser,
  // single-impact version of Kaelis's scattered crack clusters (same visual
  // family, just scaled up for "one overwhelming blow" instead of an
  // escalating stack) - NOT his plain 'smash', only these two heavy hits.
  if ((actionId === 'titanSmash' || actionId === 'glorySmash') && targetId && !dodged && amountDealt > 0) {
    addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
    addEffect(targetId, 'bigshatter', EFFECT_DURATION_MS.bigshatter);
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

  // Grudge Strike: her hammer leaves impact-crack marks (not claw scratches
  // - she doesn't have claws) scaled to how many grudge points paid off on
  // this hit, same "escalating stack" story Blood Hunt's claw count tells,
  // just in blunt-impact language instead of scratch language. Fires on any
  // landed hit (even her un-grudged baseline, which still leaves one small
  // crack) - shake stays gated on amountDealt > 1 (a real revenge payoff),
  // unchanged from before.
  if (actionId === 'grudgeStrike' && targetId && !dodged && amountDealt > 0) {
    addEffect(targetId, 'crack', EFFECT_DURATION_MS.crack, 1 + (grudgeCount || 0));
    if (amountDealt > 1) addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
  }

  // Dying Blow: a downward axe-chop wedge on any landed hit - a directional
  // slam-and-embed motion (unlike every other effect's radiate/spin/pop),
  // matching his axe rather than reusing claw/crack/vortex language. Scales
  // with his damage tier (1/2/3, driven by his OWN current hearts, not a
  // stored count like grudge/streak): tier 3 (his 3/2/1-hearts, most
  // desperate tier) adds a spreading ground-crack line and shakes, matching
  // the existing top-tier-only shake gate.
  if (actionId === 'dyingBlow' && targetId && !dodged && amountDealt > 0) {
    addEffect(targetId, 'axechop', EFFECT_DURATION_MS.axechop, amountDealt);
    if (amountDealt === 3) addEffect(targetId, 'shake', EFFECT_DURATION_MS.shake);
  }
}
