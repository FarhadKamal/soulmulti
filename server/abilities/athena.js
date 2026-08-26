import { applyDamage, applyHeal, applyShield, decayShieldIfDue, tryTriggerCleanSlate } from '../engine/damagePipeline.js';

export function onTurnStart(character, game, log) {
  decayShieldIfDue(character);
}

export const actions = {
  curseStrike: {
    label: 'Curse Strike',
    needsTarget: true, // target here is a CHARACTER belonging to the player being cursed
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the curse itself rather than
      // letting it land - the cast still happens (this counts as her turn),
      // it just has no lasting effect on the target.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'curse', characterId: character.id, targetId, blocked: true });
        return {};
      }
      character.special.curseTargetCharacterId = targetId;
      log.push({ type: 'curse', characterId: character.id, targetId });
      return {};
    },
  },
  divineRestore: {
    label: 'Divine Restore',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      // Buffed 3->4 heal, 2->3 shield (win-rate data showed her as one of
      // the weakest performers). Shield no longer decays at her own next
      // turn - now persists normally until actually consumed by incoming
      // damage, same as any other non-decaying shield source.
      applyHeal(game, character.id, 4);
      applyShield(game, character.id, 3);
      log.push({ type: 'special', characterId: character.id, actionId: 'divineRestore' });
      return {};
    },
  },
  divineSacrifice: {
    label: 'Divine Sacrifice',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // Enemy-facing damage: a normal attack in every way (target's shield
      // absorbs it like any other hit, dodge/reflect mechanics all apply
      // normally) - always flat 3, no randomness on this side.
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 3,
      });
      // Self-cost: random 1-3 hearts EVERY cast, resolved AFTER the enemy
      // hit lands (confirmed order doesn't matter here since neither side
      // affects the other's amount, but this reads naturally as "strike,
      // then pay the price"). Her own shield DOES absorb this normally
      // (confirmed ruling - an active shield can soften the gamble, unlike
      // Skull Crack's deliberate shield-ignoring pierce), and it CAN KO her
      // outright if it drops her to 0 - no floor, no safety net, a genuine
      // risk every single cast with no cooldown to space it out.
      const selfCost = 1 + Math.floor(Math.random() * 3); // 1-3 inclusive
      const selfResult = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: character.id,
        amount: selfCost,
      });
      // type: 'attack' (not 'special') - Divine Sacrifice is a normal
      // repeatable move, not her one-time signature ability (that's still
      // Divine Restore). Matches Grim Strike's own type: 'attack' pattern.
      log.push({
        type: 'attack',
        characterId: character.id,
        actionId: 'divineSacrifice',
        targetId,
        selfCost,
        selfResult,
        ...result,
      });
      return result;
    },
  },
};
