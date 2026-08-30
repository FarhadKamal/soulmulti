import { applyDamage, applyHeal, applyShield, decayShieldIfDue } from '../engine/damagePipeline.js';
import { makeSetupAction } from '../engine/categories/neutralAction.js';

// Total damage points Earthshatter scatters, regardless of alive-count -
// confirmed ruling: unlike Illyra's Mirage Overload, headcount doesn't
// matter for Tharox at all (no scaling table) - always 7, split across
// however many opponents happen to be alive when he casts it.
const EARTHSHATTER_TOTAL_DAMAGE = 7;

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
      const others = Object.values(game.characters).filter((c) => c.id !== character.id && !c.isKO);
      const landedOn = {};
      // Fully independent random assignment per point, same reasoning as
      // Mirage Overload - deliberately NOT an even/balanced split, a
      // lopsided or single-target result is normal, not a bug.
      for (let i = 0; i < EARTHSHATTER_TOTAL_DAMAGE; i++) {
        if (others.length === 0) break;
        const target = others[Math.floor(Math.random() * others.length)];
        landedOn[target.id] = (landedOn[target.id] || 0) + 1;
      }
      const hits = [];
      for (const [tid, amount] of Object.entries(landedOn)) {
        const result = applyDamage(game, log, {
          sourceCharacterId: character.id,
          targetCharacterId: tid,
          amount,
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
        hits.push({ targetId: tid, ...result });
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'earthshatter', hits });
      return { hits };
    },
  },
};
