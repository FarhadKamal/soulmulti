// Scripted 1v1 tutorial sequences - one per human-pickable character. Each
// step is either the human's forced next move or the bot's forced move,
// interleaved in the exact order they resolve (human first every round,
// per the tutorial's fixed turn order). See
// C:\Users\hp\.claude\plans\pure-sauteeing-ritchie.md for the full
// turn-by-turn heart-math proof behind every sequence below - do not edit
// these numbers without re-verifying that proof, since they're tuned so
// the human always wins against a bot dealing flat 1 damage every turn.
//
// Step shape: { actor: 'human'|'bot', actionId, targetId: 'opponent'|null,
//   forcedAmount?, ignoresShield? }
// `targetId: 'opponent'` is resolved at the call site to whichever
// character id is NOT the acting side's own character - trivial in a
// strict 1v1 where every targeted action only ever has one legal target
// anyway.

// The tutorial bot is always Boingo (no passive shield, so every
// non-shield-ignoring hit in these sequences lands at its full listed
// value with no hidden discount from Chrono Guard) - except when the
// human's own pick IS Boingo, where the bot is forced to Chronox instead
// (unavoidable, exclusivity).
export function tutorialBotCharacterId(humanCharacterId) {
  return humanCharacterId === 'boingo' ? 'chronox' : 'boingo';
}

const BOT_CYCLONE = { actor: 'bot', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 1 };
const BOT_GAMBLE = { actor: 'bot', actionId: 'chaosGamble', targetId: 'opponent', forcedAmount: 1 };

export const TUTORIAL_SEQUENCES = {
  chronox: [
    { actor: 'human', actionId: 'timeFreeze', targetId: 'opponent' },
    // Bot is frozen for its next 2 turns (see chronox.js's onTurnStart
    // freeze-continue logic) - no bot step here, its turn is skipped
    // entirely by the normal engine flow, same as any frozen character.
    { actor: 'human', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 2 },
    // Bot's second frozen turn is also skipped - still no bot step here.
    { actor: 'human', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 2 },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 2 },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 1 },
    // Bot KO'd - match ends, no further bot step.
  ],
  tharox: [
    { actor: 'human', actionId: 'titanToss', targetId: null },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'titanSmash', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'titanToss', targetId: null },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'glorySmash', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'titanSmash', targetId: 'opponent' },
    // Bot KO'd.
  ],
  zerathys: [
    { actor: 'human', actionId: 'chargeUp', targetId: null },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'chargeUp', targetId: null },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'soulSwap', targetId: 'opponent' },
    // Same turn continues - the free follow-up Thunder Wrath is a SEPARATE
    // 'soul-swap-wrath' message, not auto-fired for a human (see
    // handleSoulSwapWrath in index.js) - no bot step between these two.
    { actor: 'human', actionId: 'soulSwapWrath', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'thunderWrath', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'chargeUp', targetId: null },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'thunderWrath', targetId: 'opponent' },
    // Bot KO'd.
  ],
  akyros: [
    { actor: 'human', actionId: 'hiddenMark', targetId: 'opponent' },
    BOT_GAMBLE, // dodged (Akyros's first-ever hit taken), 0 damage regardless of forcedAmount
    { actor: 'human', actionId: 'shadowExecution', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'fatalSlash', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'fatalSlash', targetId: 'opponent' },
    // Bot KO'd.
  ],
  velorya: [
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'moonstep', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    // Bot KO'd.
  ],
  boingo: [
    { actor: 'human', actionId: 'jesterBall', targetId: 'opponent' },
    // Bot is forced to Take (flat 4, shield ignored so Chrono Guard can't
    // discount it) - Take doesn't consume the bot's own turn action (see
    // finishJesterBall in gameFlow.js), so the bot ALSO gets its normal
    // forced attack the same turn - two bot steps here, both consumed
    // before the human's next turn. 'jesterBallTake' is a synthetic
    // actionId understood only by index.js's tutorial bot-turn stepper
    // (routed to finishJesterBall(game, 'take', extra), NOT through the
    // normal executeAction/ability-map path) - it is never a real ability.
    { actor: 'bot', actionId: 'jesterBallTake', targetId: null, forcedAmount: 4, ignoresShield: true },
    { actor: 'bot', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 1 },
    { actor: 'human', actionId: 'chaosGamble', targetId: 'opponent', forcedAmount: 3 },
    // Bot KO'd.
  ],
  blade: [
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    // Bot KO'd.
  ],
  athena: [
    { actor: 'human', actionId: 'curseStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'curseStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'curseStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'divineRestore', targetId: null },
    BOT_GAMBLE, // fully absorbed by the fresh decaying shield - 0 net damage, no mirror
    { actor: 'human', actionId: 'curseStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'curseStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'curseStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'curseStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    // Bot KO'd via the final mirror.
  ],
};
