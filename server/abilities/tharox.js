import { applyDamage, applyHeal, applyShield } from '../engine/damagePipeline.js';
import { makeSetupAction } from '../engine/categories/neutralAction.js';

// Total damage points Earthshatter scatters, regardless of alive-count -
// confirmed ruling: unlike Illyra's Mirage Overload, headcount doesn't
// matter for Tharox at all (no scaling table) - always 7, split across
// however many opponents happen to be alive when he casts it.
const EARTHSHATTER_TOTAL_DAMAGE = 7;

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
  // Neutral Action (see engine/categories/neutralAction.js): sets a boolean
  // flag, mutual-exclusion toggle with titanSmash which consumes it.
  titanToss: makeSetupAction({
    label: 'Titan Toss',
    actionId: 'titanToss',
    isLegal: (character) => !character.special.hasCharge,
    mutate(character) {
      character.special.hasCharge = true;
    },
  }),
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
      log.push({ type: 'attack', characterId: character.id, actionId: 'titanSmash', targetId, ...result });
      return result;
    },
  },
  glorySmash: {
    label: 'Glory Smash',
    needsTarget: true,
    special: true,
    // 2 total casts per match (confirmed ruling, buffed from 1) - same
    // counter-instead-of-flat-flag pattern as Boingo's jesterBallsUsed.
    isLegal: (character) => character.special.hasCharge && character.special.glorySmashesUsed < 2,
    execute(character, targetId, game, log) {
      character.special.glorySmashesUsed += 1;
      // Only flips the shared usedSpecial flag once BOTH casts are spent -
      // same reasoning as jesterBall's own comment: usedSpecial is read
      // generically elsewhere as "has this character's signature move been
      // used at all," and none of those checks are Tharox-aware, so
      // setting it after just the FIRST cast would wrongly report him as
      // fully spent while he still has a second Glory Smash banked.
      if (character.special.glorySmashesUsed >= 2) character.usedSpecial = true;
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
  // Earthshatter: his desperate last-stand no-target nuke - one-time use,
  // legal only once he's genuinely on the brink (hearts <= 3, confirmed
  // ruling/corrected - same gate DIRECTION as Illyra's Mirage Overload, a
  // comeback move, not an opener). No headcount scaling at all (unlike
  // Mirage Overload's OVERLOAD_STACKS_BY_ALIVE_COUNT table) - always
  // scatters a flat EARTHSHATTER_TOTAL_DAMAGE (7) points of damage, one
  // point at a time, fully independently at random across every currently-
  // alive OPPONENT (confirmed ruling: never lands on himself). Completely
  // replaces the old "Final Smash" design (a single-target Glory-Smash
  // clone unlocked by landing Titan Smash) - no charge interaction, no
  // self-heal/shield, no relationship to hasCharge/titanSmash at all.
  earthshatter: {
    label: 'Earthshatter',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= 3 && !character.special.usedEarthshatter,
    execute(character, targetId, game, log) {
      character.special.usedEarthshatter = true;
      let others = Object.values(game.characters).filter((c) => c.id !== character.id && !c.isKO);
      // Fully independent random target per point, same reasoning as
      // Mirage Overload - deliberately NOT an even/balanced split, a
      // lopsided or single-target result is normal, not a bug. Applied ONE
      // POINT AT A TIME (not pre-assigned then applied as a lump sum per
      // target) so a target who dies partway through absorbing their
      // assigned points is removed from the pool for any REMAINING points -
      // confirmed ruling (2026-08-31, same fix as Grim Barrage's own
      // mid-cast KO redirect): the old pre-assign-then-apply design could
      // waste points as pure overkill on an already-dead target (e.g. 6 of
      // 7 points assigned to someone with only 3 hearts worth of health)
      // that were never actually available to redirect to another living
      // opponent, since the assignment happened before any damage was
      // dealt. Shield-absorption math is unaffected by this change - a
      // shield absorbs the same total whether given N points at once or
      // one at a time (Math.min(shield, amt) per hit, damagePipeline.js).
      const dealtByTarget = {};
      const koTriggeredByTarget = {};
      // First mid-cast Rebirth save (if any) - surfaced as the top-level
      // rebirthLogEntry return field, matching the single-field contract
      // finalizeAction() already checks for every other ability (see
      // turnEngine.js) - confirmed a pre-existing gap even before this
      // point-by-point rewrite (the old lump-sum version never surfaced
      // this either), fixed here while already restructuring this code.
      // Only the FIRST save is captured since Rebirth is one-shot per
      // character per match - a second character being saved in the same
      // cast is exceedingly unlikely (only Blade has Rebirth today) and
      // finalizeAction has no way to show more than one entry here anyway.
      // Same reasoning/fix extended to mirrorReflectLogEntry (Rowan's
      // Mirror Reflect) - also silently dropped by the old per-target
      // lump-sum code (confirmed via direct comparison against the pre-fix
      // version, not introduced by this change) since it sat on an
      // individual hit result object that was spread into `hits` but never
      // read back out by finalizeAction, which only ever checks the
      // top-level return value. Only the first occurrence is captured here
      // (safe - Mirror Reflect self-deactivates the instant it fires, see
      // rowan.js's own mirrorReflectActive = false, so it can genuinely
      // only trigger once per cast).
      //
      // Athena's curse-mirror is DIFFERENT and needs its own aggregation
      // (mirrorTotal/mirrorTarget below, not a single captured entry) -
      // unlike Rebirth/Mirror Reflect, her curse has no self-deactivating
      // flag, so EVERY one of Earthshatter's up-to-7 points landing on the
      // cursed caster independently triggers a fresh mirror hit. Capturing
      // only the first (as originally fixed here) silently dropped every
      // subsequent mirror hit's damage from the log line while the damage
      // itself still correctly applied to hearts - confirmed via live
      // report + direct reproduction: Tharox took 3 real mirrored damage
      // across 7 points landing on cursed Athena, but the log showed only
      // "Curse mirrors 1 damage."
      let rebirthLogEntry = null;
      let mirrorReflectLogEntry = null;
      let mirrorTotal = 0;
      let mirrorTargetId = null;
      let mirrorKoTriggered = false;
      let mirrorRevived = false;
      for (let i = 0; i < EARTHSHATTER_TOTAL_DAMAGE; i++) {
        if (others.length === 0) break;
        const target = others[Math.floor(Math.random() * others.length)];
        const result = applyDamage(game, log, {
          sourceCharacterId: character.id,
          targetCharacterId: target.id,
          amount: 1,
          // Confirmed ruling: bypasses untargetable (e.g. Velorya mid-Lunar
          // Eclipse) same as Illyra's Mirage Burst - a devastating
          // world-shaking AoE isn't something evasion should be able to
          // dodge entirely. Without this, applyDamage's own defensive
          // untargetable re-check would silently zero out any random
          // points that happened to land on her, same gap Mirage Burst had
          // before it was fixed.
          ignoresUntargetable: true,
          // Confirmed ruling: also bypasses every dodge mechanic in the
          // game (Akyros, Marin's Threefold Veil, Grimtal, Illyra's own
          // passive) - one flag gates all four (see damagePipeline.js).
          // Same reasoning as ignoresUntargetable above and as Mirage
          // Burst's own ignoresDodge - the points are already committed by
          // the moment of casting, not a fresh attack any of them could
          // still evade.
          ignoresDodge: true,
        });
        dealtByTarget[target.id] = (dealtByTarget[target.id] || 0) + (result.amountDealt || 0);
        if (result.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.rebirthLogEntry;
        if (result.mirrorLogEntry) {
          mirrorTotal += result.mirrorLogEntry.amount;
          mirrorTargetId = result.mirrorLogEntry.toCharacterId;
          // Last hit's own koTriggered/revived wins - matches the real
          // final state of the cursed target after every mirror hit this
          // cast has resolved (an earlier mirror hit KO'ing them, then a
          // later one finding them already isKO, never reaches this branch
          // at all - applyDamage's own isKO guard no-ops it - so this can
          // only ever be overwritten by a genuinely later, real hit).
          mirrorKoTriggered = result.mirrorLogEntry.koTriggered;
          mirrorRevived = result.mirrorLogEntry.revived;
        }
        if (result.mirrorResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorResult.rebirthLogEntry;
        if (result.mirrorReflectLogEntry && !mirrorReflectLogEntry) mirrorReflectLogEntry = result.mirrorReflectLogEntry;
        if (result.mirrorReflectResult?.rebirthLogEntry && !rebirthLogEntry) rebirthLogEntry = result.mirrorReflectResult.rebirthLogEntry;
        if (result.koTriggered) {
          koTriggeredByTarget[target.id] = true;
          others = others.filter((c) => c.id !== target.id);
        }
      }
      // Re-aggregated into one entry per target (matching the client's
      // existing describeLogEntry/actionEffects display, which groups by
      // target rather than showing all 7 individual points) despite being
      // computed point-by-point above.
      const hits = Object.entries(dealtByTarget).map(([tid, amountDealt]) => ({
        targetId: tid,
        amountDealt,
        koTriggered: !!koTriggeredByTarget[tid],
      }));
      log.push({ type: 'special', characterId: character.id, actionId: 'earthshatter', hits });
      const mirrorLogEntry = mirrorTargetId
        ? {
          type: 'curse-mirror', fromCharacterId: 'athena', toCharacterId: mirrorTargetId,
          amount: mirrorTotal, koTriggered: mirrorKoTriggered, revived: mirrorRevived,
        }
        : null;
      return { hits, rebirthLogEntry, mirrorLogEntry, mirrorReflectLogEntry };
    },
  },
};
