import { applyDamage, tryTriggerCleanSlate, heartsSnapshot } from '../engine/damagePipeline.js';
import { registerDodgeDefense } from '../engine/categories/dodgeDefenseRegistry.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { isProtectedByFriendship } from './melyssa.js';

function anyEnemyIsMarked(game, akyrosId) {
  const akyros = game.characters[akyrosId];
  return Object.values(game.characters).some(
    (c) => c.ownerId !== akyros.ownerId && !c.isKO && akyros.special.marks.has(c.id)
  );
}

function livingMarkedEnemies(game, akyros) {
  return Object.values(game.characters).filter(
    (c) => c.ownerId !== akyros.ownerId && !c.isKO && akyros.special.marks.has(c.id)
  );
}

// Shadow Seal (design-locked 2026-09-19, replaces Shadow Army): hearts<=3
// one-time special, NOT gated on any mark. Every OTHER living character's
// current hearts are split into an active pool (min(current, 2)) and a
// locked remainder - locked hearts are lost/irrelevant on death, only the
// active pool determines when a hit actually KOs them (see state.js's
// lockedHearts + damagePipeline.js's KO check). Healing still raises the
// active pool normally (it operates on `hearts`, and lockedHearts never
// exceeds it). No turn-based expiry - the ONLY unlock trigger is Akyros's
// own death, instant and unconditional, clearing every remaining locked
// heart across every victim at once (see registerOnOwnDeath below).
// **Threshold Shift (#38, Shadow Toll) note**: this threshold is checked
// against Akyros's own EFFECTIVE hearts count (hearts - convertedHeartCount),
// not raw hearts - see shadowSeal's own isLegal below.
const SHADOW_SEAL_HEARTS_THRESHOLD = 3;
const SHADOW_SEAL_ACTIVE_CAP = 2;

// Shadow Toll (Threshold Shift #38, design-locked 2026-09-20): a
// repeatable Normal Action, pure turn-cost, no other downside. Converts
// exactly one of Akyros's own currently-red hearts to a violet "converted"
// heart per cast - purely a bookkeeping counter (convertedHeartCount),
// never touches his real `hearts` value or his own KO condition (he still
// dies at hearts === 0 same as anyone else). The ONLY thing that reads
// convertedHeartCount is Shadow Seal's own isLegal threshold check just
// below, letting him deliberately shift when Shadow Seal becomes
// available rather than only via taking real damage. Fully symmetric,
// mutually-exclusive-visibility relationship with Shadow Seal: legal only
// while his EFFECTIVE hearts (hearts - convertedHeartCount) is still
// ABOVE the threshold (i.e. Shadow Seal isn't legal yet) and he hasn't
// used Shadow Seal, and only while at least one red heart remains to
// convert. Confirmed ruling, explicitly re-stated mid-design: "if he ever
// already used seal shadow, then it will not possible to cast it" - once
// usedShadowSeal flips true, this is gone for good regardless of what the
// live threshold would otherwise say.
function akyrosEffectiveHearts(character) {
  return character.hearts - character.special.convertedHeartCount;
}

// Dodge Defense category registration (see
// engine/categories/dodgeDefense.js) - additive, not yet consumed by
// applyDamage's own inline dodge block. Per-attacker, one-time: dodges each
// unique attacker once, tracked in dodgedAttackerIds, no recharge.
registerDodgeDefense('akyros', {
  canDodge(target, game, sourceCharacterId) {
    return !target.special.dodgedAttackerIds.has(sourceCharacterId);
  },
  consume(target, game, sourceCharacterId) {
    target.special.dodgedAttackerIds.add(sourceCharacterId);
  },
});

// KO-branch cleanup (see engine/categories/onOwnDeath.js) - marks (hidden
// and revealed) die with him, no point keeping track once he can never use
// Fatal Slash/Shadow Execution again.
registerOnOwnDeath('akyros', (character, game) => {
  character.special.marks.clear();
  character.special.revealedMarks.clear();
  // Shadow Seal's only unlock trigger - confirmed ruling: "lock will be
  // immedialty clear if caster died." Instant and unconditional, across
  // EVERY character still carrying locked hearts (not just his own marked
  // targets - Shadow Seal isn't mark-gated), including Akyros himself for
  // consistency even though a dead character's own lockedHearts no longer
  // matters gameplay-wise.
  for (const c of Object.values(game.characters)) {
    c.lockedHearts = 0;
  }
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - his current
// Hidden Mark on a now-revived character doesn't survive their death
// either - they're coming back fresh, so Fatal Slash/Shadow Execution
// shouldn't still get the marked bonus against them. Only the CURRENT mark
// is cleared (marks/revealedMarks) - everMarkedIds is left alone, so he
// still can't place a brand-new mark on them later (same "once marked,
// never again" rule as everyone else).
registerOnOtherRevived((revivedCharacterId, game) => {
  const akyros = game.characters.akyros;
  if (!akyros) return;
  akyros.special.marks.delete(revivedCharacterId);
  akyros.special.revealedMarks.delete(revivedCharacterId);
});

export const actions = {
  hiddenMark: {
    label: 'Hidden Mark',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const target = game.characters[targetId];
      // Marin's Clean Slate: consumes/blocks the mark itself - deliberately
      // does NOT add to everMarkedIds, since the mark never actually took;
      // "once marked, never again" shouldn't apply to an attempt that was
      // cleansed before it landed. blockedBy names WHICH mechanic actually
      // fired (confirmed bug, 2026-09-01 - see chronox.js's identical
      // fix/comment on Time Freeze for the full reasoning). Also fixes a
      // second gap on this specific ability: the client never displayed
      // `blocked` for hidden-mark entries at all, so a blocked mark
      // attempt used to silently read as a successful one in the log -
      // see battleScreen.js's describeLogEntry for the matching client fix.
      if (tryTriggerCleanSlate(target, game, log)) {
        log.push({ type: 'hidden-mark', characterId: character.id, targetId, hidden: true, blockedBy: 'cleanSlate' });
        return {};
      }
      // Illyra's passive does NOT block Hidden Mark - confirmed rule
      // change, 2026-09-20 (was previously wired in, see git history):
      // Hidden Mark is tagged Unrevealed Threat (#24, "a genuine negative
      // status... IS a real threat mechanically"), not No Threat (#12,
      // what Illyra's own Mirage Mark uses) - her passive dodge is meant
      // for actual attacks/threats being evaded, and letting it also block
      // a hidden status APPLICATION made no sense for that category.
      // Clean Slate (just above) remains the ONLY thing that can stop a
      // Hidden Mark attempt from landing.
      character.special.marks.add(targetId);
      // Once marked, a target can never be marked again for the rest of the
      // match - even after the mark is revealed/consumed by Fatal Slash or
      // Shadow Execution.
      character.special.everMarkedIds.add(targetId);
      // Deliberately no public log text naming the target; UI shows a
      // generic "Hidden Mark placed" line so other players can't see it.
      log.push({ type: 'hidden-mark', characterId: character.id, targetId, hidden: true });
      return {};
    },
  },
  fatalSlash: {
    label: 'Fatal Slash',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      const wasMarked = character.special.marks.has(targetId);
      if (wasMarked) character.special.revealedMarks.add(targetId);
      const amount = wasMarked ? 2 : 1;
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'fatalSlash', targetId, wasMarked, ...result });
      return result;
    },
  },
  shadowExecution: {
    label: 'Shadow Execution',
    needsTarget: true,
    special: true,
    isLegal: (character, game) => !character.usedSpecial && anyEnemyIsMarked(game, character.id),
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      // Shadow Execution can only ever target an already-marked enemy (see
      // isLegal/isValidTarget), and using it is a public, logged action - so
      // it reveals that mark just like Fatal Slash does.
      character.special.revealedMarks.add(targetId);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount: 3,
        ignoresShield: true,
      });
      log.push({ type: 'special', characterId: character.id, actionId: 'shadowExecution', targetId, ...result });
      return result;
    },
  },
  // Shadow Toll (Threshold Shift #38, design-locked 2026-09-20): see its
  // own top-of-file comment for the full mechanic. A Normal Action (not
  // Special - doesn't touch usedSpecial/Shadow Execution's own gate at
  // all), no target, no damage of its own.
  shadowToll: {
    label: 'Shadow Toll',
    needsTarget: false,
    isLegal: (character) => !character.special.usedShadowSeal
      && akyrosEffectiveHearts(character) > SHADOW_SEAL_HEARTS_THRESHOLD
      && character.special.convertedHeartCount < character.hearts,
    execute(character, targetId, game, log) {
      character.special.convertedHeartCount += 1;
      log.push({
        type: 'special', characterId: character.id, actionId: 'shadowToll',
        convertedHeartCount: character.special.convertedHeartCount, hearts: heartsSnapshot(game),
      });
      return {};
    },
  },
  // Shadow Seal (design-locked 2026-09-19): hearts<=3 one-time special,
  // NOT mark-gated (unlike Shadow Execution/the old Shadow Army). Hits
  // every OTHER living character simultaneously - deliberately bypasses
  // applyDamage entirely, same "this isn't a normal instance of that
  // mechanic" reasoning as Marin's Lifebond/Velorya's Moonlit Theft, since
  // it deals no damage and has no attacker/defender relationship to
  // resolve (no shield interaction, can't be dodged).
  shadowSeal: {
    label: 'Shadow Seal',
    needsTarget: false,
    special: true,
    // Threshold Shift (#38, Shadow Toll) - checks his EFFECTIVE hearts
    // (hearts - convertedHeartCount), not raw hearts, so converting hearts
    // via Shadow Toll can bring this threshold within reach on his own
    // schedule rather than only via taking real damage.
    isLegal: (character) => akyrosEffectiveHearts(character) <= SHADOW_SEAL_HEARTS_THRESHOLD && !character.special.usedShadowSeal,
    execute(character, targetId, game, log) {
      character.special.usedShadowSeal = true;
      // Grimtal's Beast Form (Death-Triggered Reversion #36) - same
      // exclusion as Lifebond/Moonlit Theft (confirmed ruling, 2026-09-13:
      // "yes - Beast Form should also block" bypass-everything mechanics
      // like this one, which never route through applyDamage's own
      // tryBeastFormImmunity check at all). A transformed Grimtal is left
      // completely untouched.
      //
      // Melyssa's Friendship (Redirect Bond #39) - confirmed ruling,
      // 2026-09-21: although Shadow Seal deals no damage and steals
      // nothing, splitting a victim's hearts into a smaller active pool IS
      // a harmful status effect landing on them (a lowered effective KO
      // threshold), the same shape rule #3 already redirects curse/mark/
      // freeze/poison away from her for. Unlike Moonlit Theft's shield
      // steal though, "locked hearts" is intrinsically tied to that one
      // character's OWN current hearts - there's no sensible way to
      // redirect the effect onto a different character's completely
      // different heart count, so same as Moonlit Theft's shield, this is
      // a flat EXCLUSION while bonded, not a redirect. Only ever excludes
      // HER specifically - her friend's own hearts are still a completely
      // normal, fully sealable target for everyone else, same as anyone
      // else's.
      const others = Object.values(game.characters).filter(
        (c) => c.id !== character.id && !c.isKO && !(c.id === 'grimtal' && c.special?.beastFormActive) && !isProtectedByFriendship(game, c.id)
      );
      const changes = [];
      for (const c of others) {
        const active = Math.min(c.hearts, SHADOW_SEAL_ACTIVE_CAP);
        const locked = c.hearts - active;
        changes.push({ characterId: c.id, lockedHearts: locked });
        c.lockedHearts = locked;
      }
      log.push({ type: 'special', characterId: character.id, actionId: 'shadowSeal', changes, hearts: heartsSnapshot(game) });
      return {};
    },
  },
};

export function legalShadowExecutionTargets(character, game) {
  return Object.values(game.characters).filter(
    (c) => c.ownerId !== character.ownerId && !c.isKO && character.special.marks.has(c.id)
  );
}
