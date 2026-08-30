import { applyDamage, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { registerDodgeDefense } from '../engine/categories/dodgeDefenseRegistry.js';
import { makeSetupAction } from '../engine/categories/neutralAction.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnAnyDeath } from '../engine/categories/onAnyDeath.js';

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - his own death
// ends Skull Crack's pending headache immediately, no one left to have
// caused it, same "caster's death cancels their own ongoing effects" rule
// as Rowan's poison/silence/mirror cleanup. Grim Ward simply stops
// mattering once he's dead (applyDamage's own isKO guard blocks any future
// hit from ever reading lastHitByThisCycle again), so no explicit clear
// needed for that part.
registerOnOwnDeath('grimtal', (character) => {
  character.special.headacheVictimId = null;
  character.special.headacheRollPending = false;
});

// Kill-credit bookkeeping (see engine/categories/onAnyDeath.js) - Grim
// Strike's damage is 1 + ownKillCount + claimedKillCount:
// - ownKillCount: KOs GRIMTAL HIMSELF personally lands (any of his attacks,
//   not just grimStrike) - increments automatically, no button needed.
// - claimedKillCount: KOs someone ELSE landed that Grimtal has since spent
//   a whole turn actively claiming via the Claim the Kill action (see
//   actions.claimKill below) - does NOT increment automatically just
//   because a death happened; unclaimedKillCount below is what banks up
//   waiting for that.
// isMirror excluded from the "his own kill" case for the same reasoning as
// every other attacker-attribution check in the codebase (a mirrored/
// reflected kill isn't a direct attack of his), but still banks as an
// unclaimed kill via the else branch (someone/something else's kill either
// way, from Grimtal's perspective). Fires on EVERY death in the game except
// his own (diedCharacterId !== 'grimtal') and only while he's alive himself
// to receive credit.
registerOnAnyDeath((diedCharacterId, sourceCharacterId, isMirror, game) => {
  if (diedCharacterId === 'grimtal') return;
  const grimtal = game.characters.grimtal;
  if (!grimtal || grimtal.isKO) return;
  if (sourceCharacterId === 'grimtal' && !isMirror) {
    grimtal.special.ownKillCount += 1;
  } else {
    grimtal.special.unclaimedKillCount += 1;
  }
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - his Skull
// Crack headache doesn't survive a target's own revival either, same
// "comes back fresh" reasoning - covers two distinct stale-state risks:
// (1) a pending, not-yet-rolled headache from before they died would
// otherwise still resolve on their reborn self's next turn, and (2) if the
// roll had ALREADY resolved to a skip before they died, their own
// skipHeadacheTurn flag would still be sitting true (that half is cleared
// on the revived character's OWN object, alongside their other own-state
// resets, not here - this callback only clears GRIMTAL's own tracking of
// them as a pending headache victim).
registerOnOtherRevived((revivedCharacterId, game) => {
  const grimtal = game.characters.grimtal;
  if (grimtal && grimtal.special.headacheVictimId === revivedCharacterId) {
    grimtal.special.headacheVictimId = null;
    grimtal.special.headacheRollPending = false;
  }
});

// Grim Ward and the headache-roll from Skull Crack both need to run BEFORE
// the acting character's own legal-action set is computed, so they live in
// turnEngine.js's beginCharacterTurn instead of here (see resetGrimtalCycle/
// resolveHeadacheIfDue there) - onTurnStart only handles what's purely
// Grimtal's own bookkeeping.
export function onTurnStart(character, game, log) {
  // Grim Ward's per-cycle attacker tracking resets the instant HIS OWN turn
  // starts, not the victim's (he IS the victim here) - a fresh cycle begins
  // for whoever hits him from this point on.
  character.special.lastHitByThisCycle.clear();
}

// Dodge Defense category registration (see
// engine/categories/dodgeDefense.js) - additive, not yet consumed by
// applyDamage's own inline dodge block. Grim Ward: the FIRST attacker each
// cycle (since his own last turn ended) always lands; every DISTINCT
// attacker after that dodges (repeat hits from an attacker already recorded
// this cycle do NOT dodge again). The dodge check itself must run BEFORE
// recording this hit (matching the original inline block's own
// has()-before-add ordering exactly) - recordHit is kept as a separate hook
// (rather than folding the add() into consume()) because the original
// block adds the attacker to the cycle on BOTH the dodge and no-dodge
// paths, not only on a successful dodge.
registerDodgeDefense('grimtal', {
  canDodge(target, game, sourceCharacterId) {
    const cycle = target.special.lastHitByThisCycle;
    return cycle.size > 0 && !cycle.has(sourceCharacterId);
  },
  recordHit(target, game, sourceCharacterId) {
    target.special.lastHitByThisCycle.add(sourceCharacterId);
  },
  consume(target, game, sourceCharacterId, log) {
    const aliveCount = Object.values(game.characters).filter((c) => !c.isKO).length;
    const points = aliveCount >= 4 ? 2 : aliveCount === 3 ? 1 : 0;
    let healed = 0;
    let shielded = 0;
    for (let i = 0; i < points; i++) {
      if (target.hearts < target.maxHearts) {
        target.hearts += 1;
        healed += 1;
      } else {
        target.shield += 1;
        shielded += 1;
      }
    }
    log.push({ type: 'grim-ward-reward', targetCharacterId: target.id, healed, shielded });
  },
});

export const actions = {
  grimStrike: {
    label: 'Grim Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // ownKillCount: KOs he's personally landed (auto-incremented in
      // damagePipeline.js's KO branch). claimedKillCount: kills OTHERS
      // landed that he's since spent a turn actively claiming (see
      // claimKill below) - a banked, unclaimed kill contributes nothing
      // until claimed.
      const amount = 1 + character.special.ownKillCount + character.special.claimedKillCount;
      const result = applyDamage(game, log, { sourceCharacterId: character.id, targetCharacterId: targetId, amount });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grimStrike', targetId, ...result });
      return result;
    },
  },
  // Neutral Action (see engine/categories/neutralAction.js): transfers
  // between two counters, externally driven (unclaimedKillCount is banked
  // by OTHER characters' KO events elsewhere in applyDamage, not
  // self-initiated). Costs his entire turn (no attack this same turn) -
  // plain repeatable action, not his special (Skull Crack already holds
  // that slot). Legal only while there's an actual unclaimed kill banked -
  // the button disappears entirely once everything banked has been
  // claimed, same "hidden via isLegal alone" pattern Rowan's discoverable
  // spells use (no separate hidden field needed).
  claimKill: makeSetupAction({
    label: 'Claim the Kill',
    actionId: 'claimKill',
    isLegal: (character) => character.special.unclaimedKillCount > 0,
    mutate(character) {
      character.special.unclaimedKillCount -= 1;
      character.special.claimedKillCount += 1;
    },
  }),
  skullCrack: {
    label: 'Skull Crack',
    needsTarget: true,
    special: true,
    // 3 total casts per match - a plain counter (like Boingo's
    // jesterBallsUsed) rather than the shared usedSpecial boolean, since
    // that flag is read elsewhere as a flat "has the ONE special move been
    // used" signal and only flips true once all 3 are spent (see execute).
    isLegal: (character) => character.special.skullCrackUsed < 3,
    execute(character, targetId, game, log) {
      character.special.skullCrackUsed += 1;
      if (character.special.skullCrackUsed >= 3) character.usedSpecial = true;
      // A normal targeted hit - dodgeable/reflectable by the target's own
      // mechanics (Akyros's dodge, Marin's Threefold Veil, etc.), same as
      // any other attack. ignoresShield: true is the one thing that makes
      // this "pierce" rather than a normal strike.
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 2,
        ignoresShield: true,
      });
      // Headache only takes hold if the hit actually landed (not dodged,
      // target didn't die from it - a KO'd character has no "next turn" to
      // roll against). One pending headache at a time is the natural
      // ceiling anyway: Skull Crack always targets someone and its own
      // isLegal has no extra gating, but overwriting a still-pending
      // headache on a DIFFERENT victim with a fresh one is fine (the old
      // victim just never gets their roll) since only ever the most recent
      // cast's victim matters once his own headacheVictimId is a single
      // slot, not a list - confirmed acceptable since a landed Skull Crack
      // is rare (one every several turns) and always the more recent
      // threat.
      //
      // Marin's Clean Slate: consumes/blocks the headache status itself,
      // same as Rowan's Silence Lock - the 2 pierce damage above still
      // lands normally regardless, only the headache side effect is
      // suppressed.
      let blocked = false;
      if (!result.dodged && result.amountDealt > 0 && !result.koTriggered) {
        const target = game.characters[targetId];
        // Illyra's passive checked alongside Clean Slate - same "50%
        // chance the STATUS side effect itself doesn't take" reasoning as
        // every other status-application site, independent of whatever
        // roll may have already applied to the 2 pierce damage above.
        if (tryTriggerCleanSlate(target, game, log) || tryIllyraDodgeStatus(target, game, log, character.id)) {
          blocked = true;
        } else {
          character.special.headacheVictimId = targetId;
          character.special.headacheRollPending = true;
        }
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'skullCrack', targetId, blocked, ...result });
      return result;
    },
  },
};
