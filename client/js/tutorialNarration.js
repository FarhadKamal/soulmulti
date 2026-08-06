// Per-step guidance copy shown in the action panel's title during a
// tutorial match, keyed by [humanCharacterId][actionId]. Falls back to a
// generic "use X" line built from the action's own label if no specific
// copy is written for that step - every step should still read sensibly
// even before flavor text is added for it.
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
    lunarStrike: 'Open with Lunar Strike - it ignores shields entirely.',
    moonstep: 'Moonstep deals more damage when you switch targets between hits (only one target here, so it matches Lunar Strike this time).',
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

export function tutorialNarrationFor(humanCharacterId, requiredActionId) {
  const specific = NARRATION[humanCharacterId]?.[requiredActionId];
  if (specific) return specific;
  const label = ACTION_LABELS[requiredActionId] || requiredActionId;
  return `Use ${label} to continue.`;
}
