// Per-step guidance copy shown in the action panel's title during a
// tutorial match. Resolution order: target-aware override (Velorya's 1v2
// fight, where the same action means different things depending on WHICH
// enemy it targets) -> character-state-aware override (Blade's Rebirth
// moment, detected off his own live streakCount/hearts rather than a step
// index) -> generic per-[humanCharacterId][actionId] copy -> a fallback
// "Use X to continue" built from the action's own label, so every step
// still reads sensibly even before flavor text is written for it.
const NARRATION = {
  chronox: {
    timeFreeze: "Lock them down first - use Time Freeze to make them skip two turns.",
    cyclonePunch: 'Cyclone Punch is a coin flip - 2 damage on heads, 1 on tails.',
  },
  tharox: {
    titanToss: 'Wind up with Titan Toss to bank a Titan Smash charge.',
    titanSmash: "You're charged - cash it in with Titan Smash for a big hit!",
    glorySmash: 'Use your special, Glory Smash - it hits them AND heals/shields you, and banks another charge.',
  },
  zerathys: {
    chargeUp: 'Stack a charge - Thunder Wrath hits harder the more charge you bank.',
    soulSwap: 'Use your special, Soul Swap - it swaps your current hearts with theirs, then you get a free Thunder Wrath.',
    soulSwapWrath: 'Free hit! Fire your banked-charge Thunder Wrath at no cost.',
    thunderWrath: 'Unleash Thunder Wrath - damage scales with your banked charge.',
  },
  akyros: {
    hiddenMark: "Secretly mark them with Hidden Mark - it's invisible to everyone but you until revealed.",
    shadowExecution: 'Use your special, Shadow Execution - it hits your marked target hard and ignores shields.',
    fatalSlash: 'Fatal Slash deals bonus damage against a marked target.',
  },
  velorya: {
    lunarEclipse: 'Open with your special, Lunar Eclipse - you become untargetable for your next 3 attacks!',
    lunarStrike: 'Lunar Strike ignores shields entirely.',
    moonstep: 'Moonstep deals more damage when you switch targets between hits.',
  },
  boingo: {
    jesterBall: 'Use your special, Jester Ball - throw it at your opponent and see what they do with it!',
    chaosGamble: 'Finish them with Chaos Gamble - a 33/33/34 roll for 3, 1, or 0 damage.',
  },
  blade: {
    bloodHunt: 'Keep attacking the SAME target with Blood Hunt - your streak damage climbs every hit (1, 2, 3, 4...).',
  },
  athena: {
    curseStrike: 'Curse Strike marks a target - while cursed, any damage YOU take is mirrored onto them too.',
    divineRestore: 'Use your special, Divine Restore, to heal up and shield yourself before continuing the curse.',
  },
};

const ACTION_LABELS = {
  timeFreeze: 'Time Freeze', cyclonePunch: 'Cyclone Punch',
  titanToss: 'Titan Toss', titanSmash: 'Titan Smash', glorySmash: 'Glory Smash', smash: 'Smash',
  chargeUp: 'Charge Up', soulSwap: 'Soul Swap', soulSwapWrath: 'Thunder Wrath (free)', thunderWrath: 'Thunder Wrath',
  hiddenMark: 'Hidden Mark', shadowExecution: 'Shadow Execution', fatalSlash: 'Fatal Slash',
  lunarStrike: 'Lunar Strike', moonstep: 'Moonstep', lunarEclipse: 'Lunar Eclipse',
  jesterBall: 'Jester Ball', chaosGamble: 'Chaos Gamble',
  bloodHunt: 'Blood Hunt',
  curseStrike: 'Curse Strike', divineRestore: 'Divine Restore',
};

// Velorya's 1v2 fight: the same actionId targets different enemies at
// different points, and the actually-useful teaching moment is almost
// always about the target switch itself, not the action name. Keyed by
// `${actionId}->${targetId}` against the CURRENT target and (for Moonstep
// specifically) whether it's a same-target or switch-target hit, inferred
// from the character's own live lastTargetId - see the velorya1v2
// sequence in tutorialSequences.js for the exact step order this narrates.
function veloryaNarration(actionId, targetId, character) {
  if (actionId === 'lunarStrike' && targetId === 'boingo') return 'Lunar Strike hits Boingo for a flat 1, ignoring his shield.';
  if (actionId === 'lunarStrike' && targetId === 'athena') return "Switch to Athena with Lunar Strike - she's fragile, this should finish her.";
  if (actionId === 'moonstep') {
    const lastTargetId = character?.special?.lastTargetId ?? null;
    const isSwitch = lastTargetId !== null && lastTargetId !== targetId;
    return isSwitch
      ? `Moonstep on ${targetId === 'boingo' ? 'Boingo' : 'Athena'} - you just switched targets, so this hits for -2 instead of -1!`
      : `Moonstep on ${targetId === 'boingo' ? 'Boingo' : 'Athena'} again - same target as last time, so this is the normal -1 hit.`;
  }
  return null;
}

// Blade's Rebirth moment is detected off his own live streakCount (already
// at 3 going into this click means the NEXT hit will be streak 4, the
// lethal mirror hit) rather than a hardcoded step index, so it still reads
// correctly even if the sequence's exact turn count ever changes.
function bladeNarration(actionId, character) {
  if (actionId !== 'bloodHunt') return null;
  const streak = character?.special?.streakCount ?? 0;
  if (streak === 0) return 'Open with Blood Hunt - the streak starts at 1 and climbs every consecutive hit on the same target.';
  if (streak === 1) return "Athena just shielded herself - hit again and watch what happens to the damage number.";
  if (streak >= 3) return "This hit's streak damage mirrors back onto Athena's curse target... which is YOU. Brace yourself.";
  return 'Keep the streak going - hit the same target again with Blood Hunt.';
}

export function tutorialNarrationFor(humanCharacterId, requiredActionId, requiredTargetId, character) {
  if (humanCharacterId === 'velorya') {
    const veloryaSpecific = veloryaNarration(requiredActionId, requiredTargetId, character);
    if (veloryaSpecific) return veloryaSpecific;
  }
  if (humanCharacterId === 'blade') {
    const bladeSpecific = bladeNarration(requiredActionId, character);
    if (bladeSpecific) return bladeSpecific;
  }
  const specific = NARRATION[humanCharacterId]?.[requiredActionId];
  if (specific) return specific;
  const label = ACTION_LABELS[requiredActionId] || requiredActionId;
  return `Use ${label} to continue.`;
}
