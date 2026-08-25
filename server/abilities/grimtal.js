import { applyDamage } from '../engine/damagePipeline.js';

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
      // Scales with TOTAL characters KO'd on the board so far this match -
      // any source counts (his own kills, another player's, a poison tick,
      // a curse mirror, anything), not just kills he personally lands.
      // Derived live from game state rather than a tracked counter, so
      // there's no separate bookkeeping to keep in sync anywhere else in
      // the codebase (no KO-branch special-case needed in
      // damagePipeline.js, unlike the earlier own-kills-only version).
      const totalKO = Object.values(game.characters).filter((c) => c.isKO).length;
      const amount = 1 + totalKO;
      const result = applyDamage(game, log, { sourceCharacterId: character.id, targetCharacterId: targetId, amount });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grimStrike', targetId, ...result });
      return result;
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
      if (!result.dodged && result.amountDealt > 0 && !result.koTriggered) {
        character.special.headacheVictimId = targetId;
        character.special.headacheRollPending = true;
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'skullCrack', targetId, ...result });
      return result;
    },
  },
};
