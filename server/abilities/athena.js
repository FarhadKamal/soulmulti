import { applyDamage, applyHeal, applyShield, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';

// Revival cleanup (see engine/categories/onOtherRevived.js) - her curse
// doesn't survive the cursed character's own revival (e.g. Blade's
// Rebirth); they come back "fresh" with no negative energy carried over.
registerOnOtherRevived((revivedCharacterId, game) => {
  const athena = game.characters.athena;
  if (athena && athena.special.curseTargetCharacterId === revivedCharacterId) {
    athena.special.curseTargetCharacterId = null;
  }
});

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - her curse ends
// the instant she's KO'd - no one left to trigger the mirror going forward
// (her own isKO guard at the top of applyDamage blocks any FUTURE hit from
// ever reading it again), but curseTargetCharacterId itself was otherwise
// never cleared, leaving the client's cursed-mark visual (battleScreen.js)
// and bot AI's isCursedByLiveAthena-style checks with stale state to read.
// Returns { preClearCursedId } so the curse-mirror callback below (which
// runs LATER in this same applyDamage call, after this clear) can still
// see who was cursed - the killing blow itself landed while she was alive
// and should still mirror, only hits AFTER her death shouldn't. Confirmed
// bug (pre-generalization): without this hand-off, the exact hit that
// killed a cursed Athena silently dropped its own mirror, since
// curseTargetCharacterId was already null by the time the mirror check ran.
registerOnOwnDeath('athena', (character) => {
  if (!character.special.curseTargetCharacterId) return;
  const preClearCursedId = character.special.curseTargetCharacterId;
  character.special.curseTargetCharacterId = null;
  return { preClearCursedId };
});

// Curse mirror (see engine/categories/onHitLanded.js): triggered by damage
// actually landing on Athena. Reads ctx.preClearCursedId as a fallback for
// the exact hit that just KO'd her (see the onOwnDeath registration above -
// curseTargetCharacterId is already null by the time this runs on that same
// call, since onOwnDeath's clear happens first). The mirror log entry is
// deferred (returned, not pushed to `log` here) and pushed by executeAction()
// after the triggering ability's own log entries - otherwise it lands in the
// log BEFORE the attack line that caused it, since applyDamage() runs before
// the caller's own push.
registerOnHitLanded('athena', (character, game, log, ctx) => {
  if (ctx.isMirror || ctx.amountDealt <= 0) return;
  const cursedId = character.special.curseTargetCharacterId ?? ctx.preClearCursedId;
  if (!cursedId || !game.characters[cursedId] || game.characters[cursedId].isKO) return;
  const mirrorResult = applyDamage(game, log, {
    sourceCharacterId: ctx.sourceCharacterId,
    targetCharacterId: cursedId,
    amount: ctx.amountDealt,
    ignoresShield: false,
    ignoresUntargetable: true,
    isMirror: true,
  });
  return {
    mirrorResult,
    mirrorLogEntry: {
      type: 'curse-mirror',
      fromCharacterId: 'athena',
      toCharacterId: cursedId,
      amount: ctx.amountDealt,
      koTriggered: mirrorResult.koTriggered,
      revived: mirrorResult.revived,
    },
  };
});

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
      // Illyra's passive: a 50% chance the curse status itself simply
      // doesn't take, checked alongside Clean Slate at the same point.
      if (tryIllyraDodgeStatus(target, game, log, character.id)) {
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
