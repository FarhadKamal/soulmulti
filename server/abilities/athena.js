import { applyDamage, applyHeal, applyShield, tryTriggerCleanSlate, tryIllyraDodgeStatus } from '../engine/damagePipeline.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';
import { registerOnAnyDeath } from '../engine/categories/onAnyDeath.js';

const DIVINE_JUDGMENT_HEARTS_THRESHOLD = 3;

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

// Divine Judgment (Death Pact category #31, see taxonomy) - the instant
// SHE dies, her marked victim dies too, real source damage not just a
// flag flip. Uses onAnyDeath (not onOwnDeath above) deliberately: this
// needs to call applyDamage AGAIN on a completely different character
// (the victim) after her own death is already fully resolved (isKO/hearts
// already settled), which onOwnDeath's mid-applyDamage callback timing
// isn't the right shape for - onAnyDeath fires once the triggering KO
// branch has already finished, matching Grimtal's own kill-credit
// bookkeeping's identical "call applyDamage-adjacent logic after a death
// resolves" pattern. Confirmed ruling: no exception for the victim
// delivering the killing blow themselves - it still fires. If the marked
// victim is already dead by the time she dies, this just no-ops (isKO
// guard below) - confirmed ruling, a harmless fizzle, not an error.
registerOnAnyDeath((diedCharacterId, sourceCharacterId, isMirror, game, log) => {
  if (diedCharacterId !== 'athena') return;
  const athena = game.characters.athena;
  const victimId = athena?.special?.divineJudgmentTargetId;
  if (!victimId) return;
  athena.special.divineJudgmentTargetId = null;
  const victim = game.characters[victimId];
  if (!victim || victim.isKO) return;
  // Flat lethal damage rather than a raw isKO flip - routes through the
  // normal applyDamage pipeline so every other system that expects a real
  // kill to go through there (onOwnDeath/onAnyDeath cascades for the
  // victim's OWN death, KO log/hearts snapshot, elimination/game-over
  // detection via applyEndOfActionChecks back in turnEngine.js) all still
  // fire correctly, rather than silently setting isKO=true and leaving
  // everything downstream of a normal death unaware anything happened.
  // ignoresShield/ignoresDodge/ignoresUntargetable/ignoresImmortal/
  // ignoresRebirth: true - a pact death is not a normal attack the victim
  // could have defended against in the moment (the mark itself was
  // unblockable when cast - confirmed ruling), so its actual trigger
  // shouldn't suddenly become defensible either. Deliberately amount:
  // 999 rather than a computed "exactly enough" value - simplest way to
  // guarantee a real KO regardless of the victim's current hearts/shield,
  // matching Draxus's own deathproof floor logic's spirit of "a big flat
  // number is fine when the intent is just 'this must KO regardless'."
  const result = applyDamage(game, log, {
    sourceCharacterId: 'athena',
    targetCharacterId: victimId,
    amount: 999,
    ignoresShield: true,
    ignoresDodge: true,
    ignoresUntargetable: true,
    ignoresImmortal: true,
    ignoresRebirth: true,
  });
  log.push({
    type: 'divine-judgment-trigger', fromCharacterId: 'athena', toCharacterId: victimId,
    koTriggered: result.koTriggered,
  });
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
  // Boingo's Fowl Play - confirmed ruling: "no defense of any kind" -
  // Counter Attack (curse-mirror included) is suppressed the same way
  // Rowan's Mirror Reflect is while chickenified, same reasoning (a
  // chickenified Athena still taking a hit shouldn't retaliate via her
  // curse either - her curseTargetCharacterId stays intact, untouched,
  // ready to fire normally again once she reverts).
  if (character.isChicken) return;
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
      // it just has no lasting effect on the target. blockedBy names WHICH
      // mechanic actually fired (confirmed bug, 2026-09-01 - see
      // chronox.js's identical fix/comment on Time Freeze for the full
      // reasoning).
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'curse', characterId: character.id, targetId, blockedBy: 'cleanSlate' });
        return {};
      }
      // Illyra's passive: a 50% chance the curse status itself simply
      // doesn't take, checked alongside Clean Slate at the same point.
      if (tryIllyraDodgeStatus(target, game, log, character.id)) {
        log.push({ type: 'curse', characterId: character.id, targetId, blockedBy: 'illyra' });
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
  // Divine Judgment: her hearts<=3 one-time desperation special (Death
  // Pact category #31, see taxonomy memory) - confirmed ruling: "put
  // something on victim... if athena koed. that victim will also koed."
  // Places a permanent, visible mark on one chosen living target
  // (independent of curseTargetCharacterId - can be the same character or
  // a different one, confirmed ruling). Does nothing on its own; the KO
  // trigger itself lives in this file's own registerOnAnyDeath callback
  // above, fired the instant SHE dies. Deliberately unblockable at cast
  // time too (confirmed ruling) - no tryTriggerCleanSlate/
  // tryIllyraDodgeStatus calls here, unlike every other status-application
  // in the game (Curse Strike just above, Time Freeze, Hidden Mark,
  // Silence Lock, Skull Crack all route through one or both). Also
  // deliberately NOT added to hasNegativeStatus/clearNegativeStatuses
  // (damagePipeline.js) so Rowan's Purify/Marin's Clean Slate can never
  // cleanse an already-placed mark either - "only rewind time can remove
  // it" (confirmed ruling), which falls out naturally from Chronox's
  // Rewind restoring his own whole character object wholesale if HE
  // happens to be the marked target, with no special-casing needed here
  // at all.
  divineJudgment: {
    label: 'Divine Judgment',
    needsTarget: true,
    special: true,
    isLegal: (character) => character.hearts <= DIVINE_JUDGMENT_HEARTS_THRESHOLD && !character.special.usedDivineJudgment,
    execute(character, targetId, game, log) {
      character.special.usedDivineJudgment = true;
      character.special.divineJudgmentTargetId = targetId;
      log.push({ type: 'special', characterId: character.id, actionId: 'divineJudgment', targetId });
      return {};
    },
  },
};
