import { applyDamage, isSilenced, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { flipCoin } from '../engine/random.js';

export function onTurnStart(character, game, log) {
  // Chrono Guard: shield RESETS to exactly 1 each turn - does not stack.
  // Rowan's Silence Lock suppresses this entirely while active (blocks
  // every shield source, not just special abilities) - a silenced Chronox
  // gets 0 here instead of the usual reset-to-1.
  if (isSilenced(character, game)) {
    character.shield = 0;
  } else {
    character.shield = 1;
    log.push({ type: 'passive', characterId: character.id, text: `${character.id}'s shield resets to 1 (Chrono Guard)` });
  }

  // Time Freeze: flat 2-round duration, no coin flip. Casting already skips
  // the target's next turn (round 1); this extends it for 1 more round,
  // then ends automatically.
  if (character.special.freezeActive) {
    const frozenId = character.special.freezeTargetId;
    if (character.special.freezeSkipsApplied < 2) {
      const frozen = game.characters[frozenId];
      if (frozen && !frozen.isKO) frozen.skipNextTurn = true;
      character.special.freezeSkipsApplied += 1;
      log.push({ type: 'freeze-continue', targetCharacterId: frozenId });
    } else {
      character.special.freezeActive = false;
      character.special.freezeTargetId = null;
      log.push({ type: 'freeze-end', targetCharacterId: frozenId });
    }
  }
}

export const actions = {
  cyclonePunch: {
    label: 'Cyclone Punch',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      character.special.hasActedOnce = true;
      const flip = flipCoin();
      const amount = flip === 'heads' ? 2 : 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'cyclonePunch', targetId, flip, ...result });
      return result;
    },
  },
  timeFreeze: {
    label: 'Time Freeze',
    needsTarget: true,
    special: true,
    // Not available on his very first turn - user-requested delay so he
    // can't open the match with an immediate freeze before anyone else has
    // even had a turn. Same hasActedOnce pattern as Velorya's Moonstep.
    isLegal: (character) => !character.usedSpecial && character.special.hasActedOnce,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      character.special.hasActedOnce = true;
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the freeze itself - the cast
      // still spends his special, it just never actually freezes her.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId, blocked: true });
        return { targetCharacterId: targetId };
      }
      // Illyra's passive: a 50% chance the freeze itself simply doesn't
      // take - the cast still spends his special either way, same
      // reasoning as the Clean Slate case above.
      if (tryIllyraDodgeStatus(target, game, log, character.id)) {
        log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId, blocked: true });
        return { targetCharacterId: targetId };
      }
      character.special.freezeActive = true;
      character.special.freezeTargetId = targetId;
      character.special.freezeSkipsApplied = 1;
      if (target) target.skipNextTurn = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'timeFreeze', targetId });
      return { targetCharacterId: targetId };
    },
  },
  rewind: {
    label: 'Rewind',
    // No-target: always resolves against whoever caused
    // special.lastActionAgainstMe, there's only ever one valid choice
    // (same "no target picker needed" reasoning as Grimtal's Claim the
    // Kill/Illyra's Mirage Burst).
    needsTarget: false,
    // Own dedicated counter (rewindUsesRemaining), NOT the shared usedSpecial
    // boolean - Time Freeze already owns that one, and overloading it here
    // would incorrectly also lock out Time Freeze (or vice versa) the
    // moment either was cast, same reasoning as every other multi-special
    // character in the roster (Rowan's usedSpells Set, Boingo's
    // jesterBallsUsed counter, Grimtal's skullCrackUsed counter). Usable
    // twice per match.
    special: true,
    isLegal: (character, game) => {
      if (character.special.rewindUsesRemaining <= 0) return false;
      const record = character.special.lastActionAgainstMe;
      if (!record) return false;
      const caster = game.characters[record.casterId];
      // Confirmed ruling: illegal if the qualifying attacker has since
      // died - his one precious use is preserved for a real future
      // opportunity rather than being wasted refunding a move that's now
      // moot (though he'd still get his own hearts/shield back either way
      // in principle, the ruling was explicitly "illegal," not "still
      // works, refund wasted").
      return !!caster && !caster.isKO;
    },
    execute(character, targetId, game, log) {
      character.special.rewindUsesRemaining -= 1;
      const record = character.special.lastActionAgainstMe;
      const caster = game.characters[record.casterId];
      // Restoring the CASTER's and CHRONOX's entire character objects
      // wholesale (not a hand-computed diff) is what makes this correct
      // for every possible effect type in the game uniformly - it
      // automatically refunds whatever limited-use tracking field that
      // action touched (usedSpecial, skullCrackUsed, jesterBallsUsed,
      // usedSpells, etc.) as a side effect of restoring the WHOLE object,
      // undoes any status the action placed (curse/freeze/mark/silence/
      // headache/mirageMarks all live on the caster's own special),
      // reverses Soul Swap's heart-swap (both sides' hearts are part of
      // the restored objects), and restores Illyra's stack count that a
      // Mirage Burst zeroed out. rewindUsesRemaining (decremented just
      // above, AFTER the snapshot was taken) must survive this restore,
      // since it's never part of the snapshot's own prior state.
      const rewindUsesRemaining = character.special.rewindUsesRemaining;
      // Melyssa's Mind Control lifecycle flags need the same "survive the
      // restore" treatment, for a different reason: her snapshot is always
      // taken MID-turn, while special.controlling is still true (Self
      // Choke doesn't route through executeAction, so
      // recordActionAgainstChronoxIfApplicable fires from inside
      // executeSelfChoke, before finishMelyssaTurn/finishBotMindControlTurn
      // ever clears controlling/puppetCharacterId back to false/null).
      // Restoring her whole object wholesale would resurrect that stale
      // "still mid-control" state even though her turn had genuinely
      // already ended by the time Rewind was cast - confirmed live as a
      // stuck mind-control glow/portrait on Chronox that never cleared.
      // Only relevant when Melyssa herself is the rewound caster; harmless
      // no-op (both undefined) for every other character.
      const controlling = caster.special.controlling;
      const puppetCharacterId = caster.special.puppetCharacterId;
      Object.assign(caster, structuredClone(record.casterSnapshot));
      Object.assign(character, structuredClone(record.chronoxSnapshot));
      character.special.rewindUsesRemaining = rewindUsesRemaining; // re-assert past the restore
      caster.special.controlling = controlling;
      caster.special.puppetCharacterId = puppetCharacterId;
      if (record.jesterBallSnapshot !== undefined) {
        game.jesterBall = structuredClone(record.jesterBallSnapshot);
      }
      // Lock: that exact same action is barred against Chronox specifically
      // for the caster's own next turn only (see turnEngine.js's
      // isValidTarget/tickChronoxLockoutIfAny for enforcement/timing).
      character.special.lockedActionCasterId = record.casterId;
      character.special.lockedActionId = record.actionId;
      character.special.lockedActionTurnsRemaining = 1;
      character.special.lastActionAgainstMe = null;
      log.push({
        type: 'special', characterId: character.id, actionId: 'rewind',
        rewoundCasterId: record.casterId, rewoundActionId: record.actionId,
      });
      return {};
    },
  },
};
