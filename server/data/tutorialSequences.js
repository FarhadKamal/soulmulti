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

// Bot opponent per human pick. Boingo is the default (no passive shield,
// so every non-shield-ignoring hit lands at its full listed value with no
// hidden discount from Chrono Guard) - with three deliberate exceptions:
// - Chronox (human) -> Velorya: NOT Boingo. Boingo's Chaos Gamble against
//   a Chronox HUMAN needed a forced/shield-ignored hit to land honestly
//   (his own Chrono Guard would otherwise silently eat 1 of it) - using a
//   forced override there risked reading as "this attack somehow bypasses
//   shields," which is misleading for a brand-new player. Velorya's
//   Lunar Strike genuinely, always ignores shield by its own real rules
//   (ignoresShield: true baked into velorya.js, no coin flip, no
//   tutorial-only override needed) - a completely honest flat-1 hit.
// - Boingo (human) -> Tharox: same reasoning in the other direction -
//   Tharox's own Smash is a genuinely un-shielded flat-1 hit against
//   Boingo (who has no shield to begin with), so nothing needs forcing or
//   overriding to look honest. (Boingo can't fight himself, but the
//   replacement opponent is chosen for the same "no misleading forced
//   discount" reason as Chronox's, not merely because Boingo-as-bot was
//   unavailable.)
// - Blade (human) -> Athena: not for a shield reason at all - Athena's
//   curse-mirror is what actually lets Blade's OWN Rebirth trigger for
//   real (see the blade sequence below for the full mechanic).
const TUTORIAL_BOT_BY_HUMAN = {
  boingo: 'tharox',
  chronox: 'velorya',
  blade: 'athena',
};
export function tutorialBotCharacterId(humanCharacterId) {
  return TUTORIAL_BOT_BY_HUMAN[humanCharacterId] ?? 'boingo';
}

const BOT_GAMBLE = { actor: 'bot', actionId: 'chaosGamble', targetId: 'opponent', forcedAmount: 1 };
// Velorya's Lunar Strike is never forced - it's always a genuine flat-1,
// shield-ignoring hit by its own real ability rules (see velorya.js), so
// no forcedAmount/ignoresShield override is needed or wanted here.
const BOT_LUNAR_STRIKE = { actor: 'bot', actionId: 'lunarStrike', targetId: 'opponent' };
// Tharox's Smash is likewise never forced - it's a genuine flat-1 hit
// against Boingo, who has no passive shield to interfere with it.
const BOT_SMASH = { actor: 'bot', actionId: 'smash', targetId: 'opponent' };

export const TUTORIAL_SEQUENCES = {
  chronox: [
    // Bot: Velorya, not Boingo - her Lunar Strike is a genuinely
    // shield-ignoring flat-1 hit by its own real rules (see
    // TUTORIAL_BOT_BY_HUMAN above for why this matters).
    { actor: 'human', actionId: 'timeFreeze', targetId: 'opponent' },
    // Bot is frozen for its next 2 turns (see chronox.js's onTurnStart
    // freeze-continue logic) - no bot step here, its turn is skipped
    // entirely by the normal engine flow, same as any frozen character.
    { actor: 'human', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 2 },
    // Bot's second frozen turn is also skipped - still no bot step here.
    { actor: 'human', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 2 },
    BOT_LUNAR_STRIKE,
    { actor: 'human', actionId: 'cyclonePunch', targetId: 'opponent', forcedAmount: 2 },
    BOT_LUNAR_STRIKE,
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
    // Opens with Lunar Eclipse (satisfies the turn-1 restriction, and
    // demonstrates it immediately) - becomes untargetable for her next 3
    // attacks. While untargetable, the bot doesn't merely deal 0 damage -
    // getActingCharacterId (gameFlow.js) sees the bot has ZERO valid
    // targets (Velorya is its only enemy) and skips its turn ENTIRELY,
    // same as any character with nothing legal to do - there is no bot
    // step at all during these 3 rounds, not even a whiffed one. The bot
    // only gets a real turn again once eclipse ends (partway through
    // resolving her 3rd attack).
    { actor: 'human', actionId: 'lunarEclipse', targetId: null },
    // No bot step - untargetable, bot has no legal target and is skipped.
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' }, // eclipse 1/3
    // No bot step - still untargetable.
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' }, // eclipse 2/3
    // No bot step - still untargetable.
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' }, // eclipse 3/3, ends this hit
    BOT_GAMBLE, // lands for real now - eclipse has ended
    { actor: 'human', actionId: 'moonstep', targetId: 'opponent' }, // exposes the button
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    BOT_GAMBLE,
    { actor: 'human', actionId: 'lunarStrike', targetId: 'opponent' },
    // Bot KO'd. (1+1+1 eclipsed hits, +1 moonstep, +3 more strikes = 7 exact)
  ],
  boingo: [
    // Bot: Tharox, not Chronox - Tharox has no passive shield at all, so
    // both his forced Jester Ball Take AND his own basic attack land at
    // their genuine, un-discounted values with nothing needing a
    // shield-ignoring override (unlike the original Chronox-bot version,
    // where Take needed forcedAmount+ignoresShield specifically to work
    // around Chrono Guard - exactly the kind of "this attack somehow
    // bypasses shields" behavior that reads as misleading to a new
    // player).
    { actor: 'human', actionId: 'jesterBall', targetId: 'opponent' },
    // Take doesn't consume the bot's own turn action (see finishJesterBall
    // in gameFlow.js), so the bot ALSO gets its normal attack the same
    // turn - two bot steps here, both consumed before the human's next
    // turn. 'jesterBallTake' is a synthetic actionId understood only by
    // index.js's tutorial bot-turn stepper (routed to
    // finishJesterBall(game, 'take', extra), NOT through the normal
    // executeAction/ability-map path) - it is never a real ability. No
    // forcedAmount/ignoresShield here - Tharox has no shield, so the
    // natural flat-4 Take lands honestly on its own.
    { actor: 'bot', actionId: 'jesterBallTake', targetId: null },
    BOT_SMASH,
    { actor: 'human', actionId: 'chaosGamble', targetId: 'opponent', forcedAmount: 3 },
    // Bot KO'd.
  ],
  blade: [
    // Bot: Athena, not Boingo - her curse-mirror is what actually lets
    // Blade's own Rebirth trigger for real (Boingo dealing 1 flat damage a
    // turn never threatens Blade's 7 hearts fast enough within a safe
    // sequence length, so Rebirth never had anything to revive HIM from).
    // Human goes first each round, so Blade's very first Blood Hunt lands
    // before Athena has cursed him yet (no mirror that hit) - once she
    // curses him on her first turn, every LATER Blood Hunt hit Blade lands
    // on her also mirrors that same amount back onto Blade himself (see
    // damagePipeline.js's curse-mirror block). Streak 2+3+4 mirrored
    // (2+3+4=9) exceeds Blade's remaining hearts after the streak-1 hit
    // (7-1=6), triggering his Rebirth automatically on the streak-4 hit -
    // the same action that also finishes Athena off (her total damage
    // taken: 1+2+3+4=10, well past her own 7).
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    { actor: 'bot', actionId: 'curseStrike', targetId: 'opponent' },
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    { actor: 'bot', actionId: 'curseStrike', targetId: 'opponent' },
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    { actor: 'bot', actionId: 'curseStrike', targetId: 'opponent' },
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    // Athena KO'd via the mirror; Blade's Rebirth fires the same action.
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
