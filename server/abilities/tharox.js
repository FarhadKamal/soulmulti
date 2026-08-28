import { applyDamage, applyHeal, applyShield, decayShieldIfDue } from '../engine/damagePipeline.js';

export function onTurnStart(character, game, log) {
  decayShieldIfDue(character);
}

export const actions = {
  smash: {
    label: 'Smash',
    needsTarget: true,
    isLegal: (character) => !character.special.hasCharge,
    execute(character, targetId, game, log) {
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 1,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'smash', targetId, ...result });
      return result;
    },
  },
  titanToss: {
    label: 'Titan Toss',
    needsTarget: false,
    isLegal: (character) => !character.special.hasCharge,
    execute(character, targetId, game, log) {
      character.special.hasCharge = true;
      log.push({ type: 'setup', characterId: character.id, actionId: 'titanToss' });
      return {};
    },
  },
  titanSmash: {
    label: 'Titan Smash',
    needsTarget: true,
    isLegal: (character) => character.special.hasCharge,
    execute(character, targetId, game, log) {
      character.special.hasCharge = false;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 3,
      });
      // Unlocks Final Smash (below) the first time this connects, if not
      // already used - confirmed ruling: it's a banked one-time option from
      // then on, not a same-turn-only follow-up, and doesn't block/replace
      // Smash/Toss/a later Titan Smash in the meantime. Deliberately does
      // NOT touch hasCharge at all (stays false here like before this
      // feature existed) - finalSmashAvailable is a fully independent flag,
      // checked only by finalSmash's own isLegal, so the normal combo loop
      // (Toss -> Titan Smash -> ...) keeps working exactly as it always
      // has, with Final Smash just sitting available on the side until he
      // chooses to spend it (which can be many turns and several more
      // Titan Smashes later).
      if (!character.special.usedFinalSmash) {
        character.special.finalSmashAvailable = true;
      }
      log.push({ type: 'attack', characterId: character.id, actionId: 'titanSmash', targetId, ...result });
      return result;
    },
  },
  glorySmash: {
    label: 'Glory Smash',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.special.hasCharge && !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      // Consumes the current charge and grants a brand-new one.
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 2,
      });
      applyHeal(game, character.id, 2);
      applyShield(game, character.id, 2, { decaying: true });
      character.special.hasCharge = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'glorySmash', targetId, ...result });
      return result;
    },
  },
  // Final Smash: mechanically identical to Glory Smash (2 dmg / +2 self-
  // heal / +2 decaying shield), but unlocked by landing Titan Smash at
  // least once rather than gated on holding any particular charge -
  // confirmed ruling: same numbers, fully independent one-time flag from
  // Glory Smash (either/both usable in one match, in any order), and
  // OPTIONAL/standalone once unlocked - he can freely keep using Smash/
  // Toss/Titan Smash as normal and cash Final Smash in whenever he likes on
  // any later turn, not forced to use it immediately after the Titan Smash
  // that unlocked it. needsTarget but no charge requirement at all - it
  // doesn't consume or interact with hasCharge in either direction.
  finalSmash: {
    label: 'Final Smash',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.special.finalSmashAvailable && !character.special.usedFinalSmash,
    execute(character, targetId, game, log) {
      character.special.usedFinalSmash = true;
      character.special.finalSmashAvailable = false;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 2,
      });
      applyHeal(game, character.id, 2);
      applyShield(game, character.id, 2, { decaying: true });
      log.push({ type: 'special', characterId: character.id, actionId: 'finalSmash', targetId, ...result });
      return result;
    },
  },
};
