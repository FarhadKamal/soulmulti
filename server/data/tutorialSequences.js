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
  // Velorya lives in TUTORIAL_SEQUENCES_1V2 below, not here - she needs a
  // genuine second enemy (a 'tutorial3' room) to demonstrate Moonstep's
  // real target-switch bonus, which no strict 1v1 sequence can show
  // honestly (only one legal target ever exists).
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
    //
    // Athena opens with Divine Restore (NOT Curse Strike) - this is the
    // "clue" beat: her heal caps out (6->7, only +1 real gain since she's
    // already near full from Blade's own first hit), but the +2 decaying
    // shield fully absorbs his very next Blood Hunt hit (streak 2 = amount
    // 2, shield 2 -> amountDealt 0), so that attack visibly connects but
    // deals NO damage and mirrors NOTHING - a clear signal something
    // changed, before the curse even exists yet.
    //
    // Curse only goes live on Athena's 2nd turn (after the shield has
    // already decayed to 0 at the start of that turn). From there, every
    // Blood Hunt hit Blade lands on her mirrors that same amount back onto
    // himself. Streak 3+4 mirrored (3+4=7) exceeds his remaining hearts
    // after the streak-1 hit (7-1=6), triggering Rebirth automatically on
    // the streak-4 hit - the same action that also finishes Athena off
    // (her total damage taken: 2(shielded,0 net)+3+4=7, minus the 1 real
    // point of Divine Restore healing = exactly enough to KO her at 0).
    //
    // IMPORTANT: do not reorder Divine Restore to later in the sequence -
    // Rebirth clears the curse when it fires, and if the curse were
    // already live with a prior mirror hit landed, a LATER Divine Restore
    // would let Athena's next curseStrike re-establish the curse on a
    // Blade whose rebirthUsed flag is already true, meaning a second
    // lethal mirror would no longer be intercepted (a real KO, ending the
    // match in a draw). This exact ordering (heal/shield BEFORE the curse
    // ever exists) is the only one verified safe - see the design plan doc
    // for the full hand-traced proof.
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    { actor: 'bot', actionId: 'divineRestore', targetId: null },
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' }, // the "clue" turn - fully shielded, 0 net damage
    { actor: 'bot', actionId: 'curseStrike', targetId: 'opponent' }, // curse live for the first time
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    { actor: 'bot', actionId: 'curseStrike', targetId: 'opponent' },
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    // Athena KO'd via the mirror; Blade's Rebirth fires the same action -
    // THE REBIRTH MOMENT.
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

// Velorya's 1v2 tutorial (room type 'tutorial3') - the one tutorial that
// isn't a strict 1v1. Opponents: Boingo (7 hearts, normal) and Athena (2
// hearts, deliberately fragile - her only purpose is being a genuine
// SECOND target so Moonstep's real "-2 for switching targets" bonus can be
// demonstrated honestly, which is structurally impossible with only one
// enemy). Turn order is fixed by seat index: Velorya (seat 0) -> Boingo
// (seat 1) -> Athena (seat 2) -> repeat.
//
// Mirror direction: Athena can never curse Boingo (curseStrike rejects
// same-owner/ally targets - they're both bots on the same side here), so
// her only legal curse target is Velorya herself. Whenever VELORYA's own
// attacks land on Athena, that damage mirrors back onto Velorya - this is
// a real, load-bearing threat path budgeted for exactly in the heart math
// below, not a side effect to ignore.
//
// `actor` here is always either 'human' or a LITERAL bot character id
// ('boingo' | 'athena') - never the legacy 1v1 'bot' sentinel, since there
// are two bots to disambiguate between. `targetId` is likewise always a
// literal id ('velorya' | 'boingo' | 'athena'), never the 'opponent'
// sentinel (which only makes sense with exactly one enemy).
export const TUTORIAL_SEQUENCES_1V2 = {
  velorya: [
    // Opens with Lunar Eclipse (turn-1 restriction satisfied) - becomes
    // untargetable for her next 3 attacks. Both bots' entire turns are
    // SKIPPED while she's untargetable (zero legal targets, not merely 0
    // damage - see gameFlow.js's getActingCharacterId), so this whole
    // opening is free.
    { actor: 'human', actionId: 'lunarEclipse', targetId: null },
    // boingo SKIPPED - Velorya untargetable, zero legal targets. Athena is
    // NOT skipped here even though Velorya is untargetable too - her Divine
    // Restore is self-targeted (needsTarget: false) and legal once per
    // match regardless of enemy targetability, so the engine always hands
    // her a real first turn. Harmless: both of Velorya's attacks
    // (lunarStrike, moonstep) set ignoresShield:true, so Athena's shield
    // from this never blocks any of the scripted damage below.
    { actor: 'athena', actionId: 'divineRestore', targetId: null },
    // boingo SKIPPED
    { actor: 'human', actionId: 'lunarStrike', targetId: 'boingo' }, // 1 dmg. B 7->6. eclipse 1/3
    // boingo, athena SKIPPED
    { actor: 'human', actionId: 'lunarStrike', targetId: 'athena' }, // 1 dmg. A 2->1. Uncursed yet -> NO mirror. eclipse 2/3
    // boingo, athena SKIPPED
    { actor: 'human', actionId: 'moonstep', targetId: 'boingo' }, // switch(athena->boingo) = 2 dmg. B 6->4. eclipse 3/3 -> ENDS
    { actor: 'boingo', actionId: 'chaosGamble', targetId: 'velorya', forcedAmount: 1, ignoresShield: true },
    { actor: 'athena', actionId: 'curseStrike', targetId: 'velorya' }, // curse live for the first time
    { actor: 'human', actionId: 'lunarStrike', targetId: 'athena' }, // switch(boingo->athena), flat 1. A 1->0 KO. mirrors 1->Velorya
    { actor: 'boingo', actionId: 'chaosGamble', targetId: 'velorya', forcedAmount: 1, ignoresShield: true },
    // athena SKIPPED - KO'd, seat eliminated from here on
    { actor: 'human', actionId: 'moonstep', targetId: 'boingo' }, // switch(athena->boingo) = 2 dmg. B 4->2
    { actor: 'boingo', actionId: 'chaosGamble', targetId: 'velorya', forcedAmount: 1, ignoresShield: true },
    { actor: 'human', actionId: 'moonstep', targetId: 'boingo' }, // same-target = 1 dmg (the -1 case). B 2->1
    { actor: 'boingo', actionId: 'chaosGamble', targetId: 'velorya', forcedAmount: 1, ignoresShield: true },
    { actor: 'human', actionId: 'moonstep', targetId: 'boingo' }, // same-target = 1 dmg. B 1->0 KO. MATCH OVER.
    // Boingo damage sum: 1+2+1+1+1=7 exact. Athena damage sum: 1+1=2
    // exact. Velorya hearts trace: 7,7,7,6,6,6,5,4,4,3,3,2,2 - minimum 2,
    // reached only after Boingo is already dead.
  ],
};
