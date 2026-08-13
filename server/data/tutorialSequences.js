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
    // himself.
    //
    // Athena is set to 8 max hearts for THIS tutorial only (see
    // handleCreateTutorialRoom in index.js) - 1 more than her normal 7 -
    // specifically so Rebirth and her own KO land on two SEPARATE hits
    // instead of the same one. With both at an equal 7, the mirror (an
    // exact 1:1 echo of her own damage taken) would always cross Blade's
    // remaining hearts on the identical hit that finishes her - Rebirth
    // would fire in the same instant the match ends, giving the player no
    // beat to actually witness it before the win screen. With her at 8:
    // streak-3 (3 dmg, curse live) leaves her at 5, mirrors 3 to Blade
    // (7->4). Streak-4 (4 dmg) drops her to 1 - NOT a kill - and mirrors 4
    // to Blade (4->0), triggering REBIRTH (revives to 2, streak resets to
    // 0). THE REBIRTH MOMENT, with Athena still standing. Her next turn is
    // a harmless curse re-affirm (a natural pause beat). Blade's next hit
    // is a fresh streak-1 (only 1 damage, since streak reset) - lands on
    // her last 1 heart for the actual, separate finishing blow, mirroring
    // only 1 back to the freshly-revived Blade (2->1, safely nonlethal -
    // rebirthUsed is already true, so a bigger mirror here would be a real,
    // unintercepted KO and a draw - this is why the streak reset after
    // Rebirth matters, not just the heart totals).
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
    // THE REBIRTH MOMENT - Blade "dies" and revives to 2 hearts. Athena
    // survives at 1 heart - the match does NOT end here.
    { actor: 'bot', actionId: 'curseStrike', targetId: 'opponent' }, // re-affirm; a natural pause after Rebirth
    { actor: 'human', actionId: 'bloodHunt', targetId: 'opponent' },
    // Fresh post-Rebirth streak (reset to 0) lands for only 1 - finishes
    // Athena's last heart. Separate beat from the Rebirth moment above.
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
  // Melyssa's 1v2 tutorial - like Velorya's, she needs a genuine second
  // enemy: her one real action, Mind Control, puppets ANY other character
  // (ally or enemy) into their own real kit, which is structurally
  // impossible to demonstrate honestly ("puppet an enemy into attacking
  // the OTHER enemy") in a strict 1v1. Opponents: Velorya (her Lunar
  // Strike/Moonstep are genuinely, always ignoresShield:true by her own
  // real ability rules, exactly as her own tutorial above already relies
  // on) and Tharox (his Smash/Titan Smash are genuinely normal, shield-
  // absorbed attacks) - deliberately chosen so every hit in this sequence
  // is the honest, real behavior of each character's own kit, nothing
  // forced or overridden (unlike TUTORIAL_SEQUENCES' single-opponent
  // BOT_GAMBLE, whose forcedAmount path makes Chaos Gamble silently
  // ignoresShield in tutorial mode - misleading for Melyssa's shield
  // lesson specifically, see the design discussion this sequence came out
  // of). Velorya starts at 3 hearts, Tharox at 2 (both reduced from 7,
  // same "deliberately fragile" idea as Athena's 2-heart override below)
  // so the match resolves in a reasonable number of turns. Tharox
  // specifically needs at least 1 heart left after the opening puppeted
  // hit (T1) or the later charge/Titan Smash beat never gets to happen -
  // a flat 1 would die immediately, so he gets 2.
  //
  // Turn order fixed by seat index: Melyssa (seat 0) -> Velorya (seat 1)
  // -> Tharox (seat 2) -> repeat. This exact order matters for TWO
  // different reasons at once:
  // 1. The shield lesson needs Velorya to act right before Tharox each
  //    round: Melyssa's own onTurnStart decays her shield (decayShieldIfDue,
  //    see melyssa.js) the instant HER turn begins - Velorya's
  //    ignoresShield hit sets the shield, and it survives just long enough
  //    for Tharox's very next NORMAL hit to actually be absorbed by it,
  //    before Melyssa's own following turn wipes it clean. (The reverse
  //    order - Tharox before Velorya - was tried first and doesn't work:
  //    Melyssa's own turn always falls between Velorya's hit and Tharox's
  //    NEXT hit, so a Tharox-set shield could only ever be "tested" by
  //    Velorya's shield-ignoring hit, which bypasses it anyway - no real
  //    absorption ever happens.)
  // 2. The Titan Smash beat needs Tharox's OWN real turn (T3) to be what
  //    charges him up, not a puppeted Titan Toss - puppeting his charge
  //    herself would let HIS OWN very next real turn auto-fire Titan Smash
  //    on its own (charged = his only legal move) before Melyssa ever got
  //    a second turn to puppet it herself. Only works because Melyssa's
  //    turn (T4) comes immediately after his (T3), before his own next
  //    real turn (T5) can consume the charge itself.
  // Re-verified against a live playthrough before locking this in.
  //
  // A mindControl step's own targetId is the PUPPET being selected; the
  // step(s) immediately after it carry `puppetOf: <that same puppet id>`
  // instead of `actor` resolving to the puppet - `actor` stays 'human'
  // throughout (Melyssa's own seat is what must act/be driven), matching
  // executeTutorialStep's puppetOf branch exactly.
  //
  // Heart trace (Melyssa / Velorya / Tharox) after each of the 6 turns:
  // 7,3,2 -> T1 7,3,1 -> T2 6,3,1 -> T3 6,3,1 -> T4 6,0,1(Velorya KO) ->
  // T5 5,0,1(Smash is a genuine flat 1, shield=0 so unabsorbed) -> T6
  // 5,0,0 (Tharox KO, match over). Melyssa's minimum is 5, both enemies KO'd.
  melyssa: [
    // T1: puppet Velorya -> Lunar Strike Tharox. Redirects an enemy at the
    // OTHER enemy - the core Mind Control lesson (ignoresShield is genuine
    // but moot here, Tharox has no shield to begin with). Tharox 2->1
    { actor: 'human', actionId: 'mindControl', targetId: 'velorya' },
    { actor: 'human', actionId: 'lunarStrike', targetId: 'tharox', puppetOf: 'velorya' },
    // T2: Velorya's own real turn - genuinely ignoresShield, shield=0 so
    // the full 1 hits Melyssa's hearts either way, then her reactive
    // shield gains exactly 1.
    { actor: 'velorya', actionId: 'lunarStrike', targetId: 'melyssa' }, // M 7->6, shield 0->1
    // T3: Tharox's OWN real turn - not charged yet, uses Titan Toss
    // (charge, no attack). This is what makes the T4 puppeted Titan Smash
    // legal - his own charge, not one Melyssa set up herself (see the
    // long comment above for why puppeting the charge wouldn't work).
    { actor: 'tharox', actionId: 'titanToss', targetId: null },
    // T4: puppet Tharox -> Titan Smash Velorya (he's charged from HIS OWN
    // T3 turn). Puppeting a charged special, not just a plain attack - a
    // beat the earlier tutorial draft never showed. 3 dmg, exact KO on
    // Velorya's 3 hearts.
    { actor: 'human', actionId: 'mindControl', targetId: 'tharox' },
    { actor: 'human', actionId: 'titanSmash', targetId: 'velorya', puppetOf: 'tharox' }, // Velorya 3->0 KO
    // T5: Tharox's own real turn (Velorya dead, his charge already
    // consumed by T4's puppeted Titan Smash) - back to a genuinely normal,
    // flat-1 Smash (no randomness - see tharox.js). Melyssa's shield is 0
    // here (decayed at the start of her own T4 turn, nothing re-set it
    // since Velorya, the only ignoresShield attacker, is already dead) -
    // this hit lands unabsorbed, straight on her hearts.
    { actor: 'tharox', actionId: 'smash', targetId: 'melyssa' }, // shield=0. M 6->5, shield SET->1 (moot - match ends next turn)
    // T6: puppet Tharox -> Self Choke. Tharox 1->0 KO. MATCH OVER.
    { actor: 'human', actionId: 'mindControl', targetId: 'tharox' },
    { actor: 'human', actionId: '__mcSelfChoke', targetId: null, puppetOf: 'tharox' },
  ],
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
