import { applyDamage, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';

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
  claimKill: {
    label: 'Claim the Kill',
    needsTarget: false,
    // Costs his entire turn (no attack this same turn) - plain repeatable
    // action, not his special (Skull Crack already holds that slot).
    // Legal only while there's an actual unclaimed kill banked - the
    // button disappears entirely once everything banked has been claimed,
    // same "hidden via isLegal alone" pattern Rowan's discoverable spells
    // use (no separate hidden field needed).
    isLegal: (character) => character.special.unclaimedKillCount > 0,
    execute(character, targetId, game, log) {
      character.special.unclaimedKillCount -= 1;
      character.special.claimedKillCount += 1;
      log.push({ type: 'setup', characterId: character.id, actionId: 'claimKill' });
      return {};
    },
  },
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
