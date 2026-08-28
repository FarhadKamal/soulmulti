import {
  getUsableActions, isValidTarget, isValidPuppetTarget, isValidMindControlTarget, isMelyssaLoneDuel, LONE_DUEL_EXCEPTIONS,
} from './turnEngine.js';

// Pure decision logic for PC-controlled characters - no DOM, no side
// effects. Given a character whose turn it is, returns the action+target
// the bot wants to use. The caller (dashboardScreen.js) feeds this straight
// into the same onActionChosen() path a human click would use, so bots and
// humans always resolve identically once a choice is made.

function livingEnemies(game, character) {
  return Object.values(game.characters).filter(
    (c) => c.ownerId !== character.ownerId && !c.isKO && !c.untargetable
  );
}

function validTargetsFor(game, character, actionId) {
  return Object.keys(game.characters).filter((tid) => isValidTarget(game, character.id, actionId, tid));
}

// Picks a uniformly random element - used to break ties between equally
// good targets instead of always favoring whichever one happens to appear
// first in iteration order. game.characters is a plain object built by
// inserting each player's character in seat order, so Object.keys() (and
// any find()/reduce() over it) always lists Player 1's character first -
// a naive tie-break would silently and consistently favor attacking
// Player 1 above everyone else on any full-health/equal-score comparison,
// which is exactly what happened before this fix (confirmed via a 500-
// match simulation: Player 1 won ~6% of the time vs. Player 4's ~53%).
function pickRandom(ids) {
  return ids[Math.floor(Math.random() * ids.length)];
}

// Prefers whichever legal target has the fewest hearts left (closest to a
// kill) - a simple but effective default "focus the weakest enemy" rule
// used as a fallback whenever a character has no more specific priority.
// Ties (e.g. everyone at full health) are broken randomly, not by seat order.
function lowestHeartsTarget(game, targetIds) {
  if (targetIds.length === 0) return null;
  const minHearts = Math.min(...targetIds.map((tid) => game.characters[tid].hearts));
  const tied = targetIds.filter((tid) => game.characters[tid].hearts === minHearts);
  return pickRandom(tied);
}

// How much recent damage each living enemy has dealt to this character,
// read from the match log - used to identify "who's been attacking me
// most" for defensive/retaliation decisions. Looks at the last 30 log
// entries, which comfortably covers a couple of full rounds.
function threatByAttacker(game, character) {
  const tally = {};
  const recent = game.log.slice(-30);
  for (const entry of recent) {
    if (entry.targetCharacterId !== character.id && entry.targetId !== character.id) continue;
    const attackerId = entry.characterId || entry.sourceCharacterId;
    if (!attackerId || attackerId === character.id) continue;
    const dmg = entry.amountDealt || 0;
    if (dmg > 0) tally[attackerId] = (tally[attackerId] || 0) + dmg;
  }
  return tally;
}

function biggestThreatTarget(game, character, targetIds) {
  if (targetIds.length === 0) return null;
  const tally = threatByAttacker(game, character);
  const scored = targetIds.map((tid) => ({ tid, score: tally[tid] || 0 }));
  const bestScore = Math.max(...scored.map((s) => s.score));
  if (bestScore <= 0) return null;
  const tied = scored.filter((s) => s.score === bestScore).map((s) => s.tid);
  return pickRandom(tied);
}

// True if this character is currently the cursed target of a live Athena -
// used to steer bots away from attacking Athena while cursed, since that
// damage mirrors straight back onto them.
function isCursedByLiveAthena(game, character) {
  const athena = Object.values(game.characters).find(
    (c) => c.id === 'athena' && !c.isKO && c.special.curseTargetCharacterId === character.id
  );
  return !!athena;
}

// True if Rowan is alive and his Mirror Reflect window is currently active -
// landing any non-lethal direct hit on him while it's up deals 3 damage
// straight back to the attacker. Same avoidance shape as
// isCursedByLiveAthena: steer bots away from hitting him unless he's the
// only legal target or the hit would kill him outright (a kill ends the
// threat regardless of the reflect, so it's still worth it - same reasoning
// already applied to Athena's curse mirror).
function isMirrorReflectActive(game) {
  const rowan = game.characters['rowan'];
  return !!(rowan && !rowan.isKO && rowan.special?.mirrorReflectActive);
}

const LOW_HEARTS_THRESHOLD = 3;

// Focus-fire: prefer whichever legal target is already the MOST hurt
// relative to their own max hearts (i.e. closest to dying), so independent
// bots naturally converge on finishing someone off instead of each
// spreading damage across different targets every turn. Only kicks in once
// a target has actually taken damage (missingHearts > 0) - otherwise it's
// equivalent to "attack whoever's weakest" even at full health, which
// isn't really "focus fire," just a baseline preference.
// Only treats a wounded target as a focus-fire opportunity once they're
// actually close to dying (at or below the same low-hearts threshold used
// elsewhere) - otherwise a target that's taken a single stray point of
// damage would outrank someone who's been repeatedly, heavily attacking
// this character but happens to still be at full health. Confirmed via a
// real match: two characters kept trading blows with each other purely
// because they'd landed a hit on each other first, while a third player at
// full health kept freely attacking both of them unchallenged the whole
// game and mopped up the survivor.
function focusFireTarget(game, targetIds) {
  const wounded = targetIds.filter((tid) => {
    const t = game.characters[tid];
    return t.hearts < t.maxHearts && t.hearts <= LOW_HEARTS_THRESHOLD;
  });
  if (wounded.length === 0) return null;
  const maxMissing = Math.max(...wounded.map((tid) => {
    const t = game.characters[tid];
    return t.maxHearts - t.hearts;
  }));
  const tied = wounded.filter((tid) => {
    const t = game.characters[tid];
    return t.maxHearts - t.hearts === maxMissing;
  });
  return pickRandom(tied);
}

// True if Athena is alive, currently cursing someone OTHER than this
// attacker, and a legal target - meaning a hit on Athena deals damage to
// BOTH her and the cursed target (her own hit, plus the mirror) instead of
// just one character taking it. Strictly better value than hitting the
// cursed target directly for the same single action, as long as it isn't
// this attacker being cursed (handled separately, since that mirror comes
// back at them instead of being a bonus).
function athenaDoubleDipTarget(game, character, targets) {
  if (!targets.includes('athena')) return null;
  const athena = game.characters['athena'];
  const cursedId = athena?.special?.curseTargetCharacterId;
  if (!cursedId || cursedId === character.id) return null;
  const cursedTarget = game.characters[cursedId];
  if (!cursedTarget || cursedTarget.isKO) return null;
  return 'athena';
}

// minDamage: when the caller knows the exact (or minimum) damage the chosen
// action will deal and the hit isn't shield-ignoring, a target whose shield
// would fully absorb it nets zero effect - avoid wasting the action on them
// when an unarmored alternative exists. Optional: omitted by callers whose
// damage varies too unpredictably to check safely (coin flips, moderator
// outcomes), in which case shield isn't considered at all.
function pickDefaultTarget(game, character, actionId, minDamage = null) {
  const targets = validTargetsFor(game, character, actionId);
  if (targets.length === 0) return null;
  // Avoid hitting Athena while self-cursed unless she's the only option or
  // it would finish her off (worth eating the mirror for a kill).
  const nonAthenaSafe = targets.filter((tid) => {
    const t = game.characters[tid];
    if (t.id !== 'athena' || !isCursedByLiveAthena(game, character)) return true;
    return false;
  });
  let pool = nonAthenaSafe.length > 0 ? nonAthenaSafe : targets;
  if (minDamage !== null) {
    const unarmored = pool.filter((tid) => game.characters[tid].shield < minDamage);
    if (unarmored.length > 0) pool = unarmored;
  }
  // Avoid hitting a Mirror-Reflect-active Rowan with a non-lethal hit -
  // unless he's the only option left, or the hit would kill him outright
  // (see isMirrorReflectActive above for the reasoning).
  if (isMirrorReflectActive(game) && pool.includes('rowan')) {
    const rowanTarget = game.characters['rowan'];
    const wouldKillRowan = minDamage !== null
      && rowanTarget.hearts <= Math.max(0, minDamage - rowanTarget.shield);
    if (!wouldKillRowan) {
      const nonRowanSafe = pool.filter((tid) => tid !== 'rowan');
      if (nonRowanSafe.length > 0) pool = nonRowanSafe;
    }
  }
  // Hitting Athena while she's cursing someone else lands damage on both of
  // them for the price of one action - take that free value over any other
  // priority whenever it's available and safe.
  const doubleDip = athenaDoubleDipTarget(game, character, pool);
  if (doubleDip) return doubleDip;
  // Priority: secure a kill on whoever's already most wounded (focus fire)
  // over just retaliating against the most recent attacker - finishing a
  // target off is worth more than spreading damage around.
  return focusFireTarget(game, pool) || biggestThreatTarget(game, character, pool) || lowestHeartsTarget(game, pool);
}

// ---- Per-character move selection ----
// Each function returns { actionId, targetId } or null if it has nothing
// usable (shouldn't normally happen - getUsableActions always offers
// something when the character can act at all).

function chooseTharoxMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Earthshatter: standalone, no-target, one-time (see tharox.js) - a
  // desperation move, only legal once hearts <= 3 (same gate direction as
  // Illyra's Mirage Overload). No real downside to casting it the instant
  // it's available (no self-damage, no cost) - doesn't touch hasCharge at
  // all, so it's checked first, unconditionally, ahead of the
  // mandatory-cash-in narrowing below.
  if (byId.earthshatter) {
    return { actionId: 'earthshatter', targetId: null };
  }
  // Mandatory cash-in already narrows usable to just Titan Smash/Glory
  // Smash while charged - prefer Glory Smash (heal+shield bonus) whenever
  // it's available, otherwise Titan Smash.
  if (byId.glorySmash) {
    return { actionId: 'glorySmash', targetId: pickDefaultTarget(game, character, 'glorySmash', 2) };
  }
  if (byId.titanSmash) {
    return { actionId: 'titanSmash', targetId: pickDefaultTarget(game, character, 'titanSmash', 3) };
  }
  // Uncharged: Smash (flat -1, no shield ignore) secures an immediate kill
  // on anyone already at 1 heart with no shield - don't pass that up just
  // to build a charge for later, since the target won't be around later.
  if (byId.smash) {
    const smashTargets = validTargetsFor(game, character, 'smash');
    const securesKill = smashTargets.find((tid) => {
      const t = game.characters[tid];
      return t.hearts <= Math.max(0, 1 - t.shield);
    });
    if (securesKill) {
      return { actionId: 'smash', targetId: securesKill };
    }
  }
  // Otherwise, Toss to build a charge for the much bigger Titan Smash later -
  // UNLESS Athena is the ONLY living enemy (cursing Tharox already, or not
  // yet but a live Athena in a 1v1 will curse whoever her only target is on
  // her very next turn regardless), in which case charging is a trap: Titan
  // Smash/Glory Smash are MANDATORY once charged (no way to hold back or
  // pick a different target - pickDefaultTarget's own Athena-avoidance
  // can't help when she's the only option), so committing to a charge here
  // locks in a forced, likely self-lethal mirror hit with no way out.
  // Confirmed via a real match: Tharox charged while Athena was his only
  // remaining enemy, she cursed him on her very next turn, and he was then
  // forced into Titan Smash, mutual-killing himself finishing her off - a
  // poke with plain Smash instead (safe, just slower) would have won
  // cleanly over several more turns with zero risk. Only holds back when
  // the eventual trade would actually be fatal (character.hearts <= 3,
  // Titan Smash's damage) - a survivable mirror is still worth charging
  // for the bigger hit.
  if (byId.titanToss) {
    const enemies = livingEnemies(game, character);
    const onlyAthenaLeft = enemies.length === 1 && enemies[0].id === 'athena';
    if (!(onlyAthenaLeft && character.hearts <= 3)) {
      return { actionId: 'titanToss', targetId: null };
    }
  }
  return { actionId: 'smash', targetId: pickDefaultTarget(game, character, 'smash') };
}

function chooseZerathysMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  const chargeCount = character.special.chargeCount;
  const wrathDamage = [1, 2, 3][chargeCount];
  // Thunder Wrath at CURRENT charge secures an immediate kill - don't pass
  // that up to sit and charge further, since the target won't be around
  // later. Shield absorbs first, so it must be low enough to still die
  // after that.
  if (byId.thunderWrath) {
    const wrathTargets = validTargetsFor(game, character, 'thunderWrath');
    const killableTargets = wrathTargets.filter((tid) => {
      const t = game.characters[tid];
      return t.hearts <= Math.max(0, wrathDamage - t.shield);
    });
    if (killableTargets.length > 0) {
      // When multiple targets are all killable this turn, prefer one that
      // doesn't also kill Zerathys himself via Athena's curse mirror -
      // killing self-cursing Athena is only worth it when it's the ONLY
      // kill on offer (or part of the deliberate mutual-kill logic below);
      // if a completely safe kill exists elsewhere, take that instead.
      // Confirmed via a real match: the bot killed a self-cursing Athena
      // while an equally-killable, non-mirroring Chronox was also
      // available - the mirror finished Zerathys off for no reason, when
      // killing Chronox would have won the kill with zero downside.
      const selfCursing = isCursedByLiveAthena(game, character);
      const safeKills = selfCursing
        ? killableTargets.filter((tid) => tid !== 'athena')
        : killableTargets;
      const securesKill = safeKills[0] ?? killableTargets[0];
      return { actionId: 'thunderWrath', targetId: securesKill };
    }
  }
  // Soul Swap is strongest when the target has meaningfully more hearts
  // than Zerathys - stealing their pool and dumping his lower total onto
  // them. Use it opportunistically once available.
  if (byId.soulSwap) {
    const targets = validTargetsFor(game, character, 'soulSwap');
    const maxHearts = Math.max(...targets.map((tid) => game.characters[tid].hearts));
    const tiedBest = targets.filter((tid) => game.characters[tid].hearts === maxHearts);
    const best = pickRandom(tiedBest);
    if (best && game.characters[best].hearts > character.hearts + 1) {
      return { actionId: 'soulSwap', targetId: best };
    }
  }
  // Self-curse-mirror handling: if Zerathys is cursed and his only legal
  // Thunder Wrath target is Athena herself (no safe alternative exists),
  // landing that hit mirrors the SAME damage back onto him.
  const wrathTargetsNow = validTargetsFor(game, character, 'thunderWrath');
  const onlyTargetIsCursingAthena = wrathTargetsNow.length === 1
    && wrathTargetsNow[0] === 'athena'
    && isCursedByLiveAthena(game, character);
  if (onlyTargetIsCursingAthena) {
    const athena = game.characters['athena'];
    const maxChargeDamage = 3;
    const mirrorSurvivableNow = character.hearts > wrathDamage;
    const wouldKillAthenaNow = athena.hearts <= Math.max(0, wrathDamage - athena.shield);
    // Checked FIRST, regardless of whether the current hit happens to be
    // survivable: if Zerathys can never actually WIN this 1v1 by trading
    // small safe hits (he'll always be behind since he's taking equal
    // mirror damage each time, same as Athena, but she gets to heal/keep
    // cursing for free), the only way to come out ahead is a mutual kill -
    // charge all the way to max and cash in for a hit that finishes them
    // both off, if Athena's hearts make that reachable. Charging itself
    // costs nothing here (Curse Strike doesn't damage him), so this is
    // always worth pursuing over a smaller poke that doesn't progress
    // toward a win, unless the current charge already secures an outright
    // kill on its own (handled above) or charging further would leave
    // Athena still alive and unkillable even at max charge.
    const canForceMutualKillAtMax = !wouldKillAthenaNow
      && athena.hearts <= Math.max(0, maxChargeDamage - athena.shield);
    if (canForceMutualKillAtMax) {
      if (chargeCount < 2 && byId.chargeUp) {
        return { actionId: 'chargeUp', targetId: null };
      }
      return { actionId: 'thunderWrath', targetId: 'athena' };
    }
    if (!mirrorSurvivableNow) {
      // No mutual kill reachable and the current hit would kill him for
      // nothing - nothing better to do than attack now, so fall through.
    } else if (!wouldKillAthenaNow && chargeCount < 2) {
      const nextChargeDamage = wrathDamage + 1;
      const mirrorSurvivableIfCharged = character.hearts > nextChargeDamage;
      if (!mirrorSurvivableIfCharged) {
        // Charging further would push the eventual mirror past what's
        // survivable, but cashing in at the CURRENT charge is still safe -
        // take the smaller, safe hit now instead of risking it later.
        return { actionId: 'thunderWrath', targetId: 'athena' };
      }
    }
  }
  // At max charge, always cash in - no reason to hold at the cap.
  if (chargeCount >= 2) {
    return { actionId: 'thunderWrath', targetId: pickDefaultTarget(game, character, 'thunderWrath', wrathDamage) };
  }
  // Low hearts: normally don't sit around charging, take the guaranteed hit
  // now - but only when there's an actual reason to rush (a live cursing
  // Athena punishes every turn spent charging via the mirror). Charging
  // itself never costs Zerathys anything defensively against a non-mirror
  // opponent - the enemy gets their turn regardless of which Zerathys move
  // is chosen - so cashing in early just for being low on hearts throws
  // away a bigger, more decisive hit for no protective benefit. Confirmed
  // via a real match: cashing in a weak 1-damage hit at 1 heart left a
  // 2-heart Akyros alive for one more turn, which then landed the killing
  // blow - charging once first would have secured the kill instead.
  if (character.hearts <= LOW_HEARTS_THRESHOLD && isCursedByLiveAthena(game, character)) {
    return { actionId: 'thunderWrath', targetId: pickDefaultTarget(game, character, 'thunderWrath', wrathDamage) };
  }
  if (byId.chargeUp) {
    return { actionId: 'chargeUp', targetId: null };
  }
  return { actionId: 'thunderWrath', targetId: pickDefaultTarget(game, character, 'thunderWrath', wrathDamage) };
}

// Target for the free Thunder Wrath that fires immediately after Soul Swap
// (chargeCount is always 0 at that point, dealing 1 damage). Reuses the same
// kill-securing/shield-aware/double-dip/self-curse-safety logic as a normal
// Thunder Wrath choice, rather than a plain random pick - confirmed via a
// real match where a fully random follow-up wasted the free hit on a
// shielded target (0 damage through the shield) instead of an unshielded
// one that would have landed real damage.
//
// excludeOwnerId: when this follow-up is firing off a PUPPETED Soul Swap
// (Melyssa puppeting Zerathys, see stepBotMindControlTurn in index.js),
// this function has no awareness on its own that the "attacker" is really
// Melyssa - left unchecked, it happily rates Melyssa's own side as a normal
// target (focus-fire/lowest-hearts/etc. don't know any better) and can
// freely land a real hit on her, completely bypassing
// chooseBotMelyssaPuppetAction's own Self Choke safety check (which only
// covers the puppet's INITIAL move, never this automatic follow-up).
// Confirmed via a live report: Melyssa at 7 hearts still lost to a
// puppeted Zerathys in a 4p match. Passing Melyssa's ownerId here excludes
// her whole side from the candidate pool before any of the normal
// heuristics run; a normal (non-puppeted) Soul Swap never passes this, so
// its own behavior is completely unchanged.
export function chooseSoulSwapWrathTarget(character, game, excludeOwnerId = null) {
  const targets = validTargetsFor(game, character, 'soulSwapWrath')
    .filter((tid) => !excludeOwnerId || game.characters[tid].ownerId !== excludeOwnerId);
  if (targets.length === 0) return null;
  const securesKill = targets.find((tid) => {
    const t = game.characters[tid];
    return t.hearts <= Math.max(0, 1 - t.shield);
  });
  if (securesKill) return securesKill;
  // Prefer an unshielded target so the hit actually lands instead of being
  // fully absorbed for zero effect.
  const unshielded = targets.filter((tid) => game.characters[tid].shield <= 0);
  const pool = unshielded.length > 0 ? unshielded : targets;
  const doubleDip = athenaDoubleDipTarget(game, character, pool);
  if (doubleDip) return doubleDip;
  return focusFireTarget(game, pool) || biggestThreatTarget(game, character, pool) || lowestHeartsTarget(game, pool);
}

function chooseChronoxMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Rewind first, whenever it's legal at all - it's a free heal, a free
  // status cleanse, a free refund of whatever the caster spent, AND locks
  // that exact move out against him next turn, all with zero downside
  // beyond the one turn it costs (it's never illegal to cast when there's
  // genuinely nothing to undo - isLegal already requires a real qualifying
  // record). Same "no reason to hold it" reasoning as Rowan's Arcane Study
  // fallback and Grimtal's Claim the Kill.
  if (byId.rewind) {
    return { actionId: 'rewind', targetId: null };
  }
  // Time Freeze is best spent either defensively (Chronox himself is low
  // and needs to lock down whoever's been hurting him) or offensively on
  // the biggest live threat once available - it denies 2 of their turns.
  if (byId.timeFreeze) {
    const targets = validTargetsFor(game, character, 'timeFreeze');
    const threatId = biggestThreatTarget(game, character, targets) || lowestHeartsTarget(game, targets);
    if (threatId && (character.hearts <= LOW_HEARTS_THRESHOLD || targets.length > 0)) {
      return { actionId: 'timeFreeze', targetId: threatId };
    }
  }
  return { actionId: 'cyclonePunch', targetId: pickDefaultTarget(game, character, 'cyclonePunch') };
}

function chooseAkyrosMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  let markedTargets = validTargetsFor(game, character, 'shadowExecution');
  let fatalTargets = validTargetsFor(game, character, 'fatalSlash');
  // Mirror Reflect avoidance: unlike Athena's curse (handled below via
  // athenaIsCursingRisk), most of this function picks a target directly
  // from markedTargets/fatalTargets rather than routing through
  // pickDefaultTarget, so that helper's own avoidance never sees these
  // picks. Strip Rowan from both pools up front whenever hitting him
  // wouldn't be lethal and a safer alternative exists - Shadow Execution
  // ignores shield for a flat 3, Fatal Slash's marked bonus is 2, so check
  // each action's own would-be damage against his current hearts/shield
  // before excluding him from ITS pool specifically.
  if (isMirrorReflectActive(game) && (markedTargets.includes('rowan') || fatalTargets.includes('rowan'))) {
    const rowan = game.characters['rowan'];
    const shadowWouldKill = rowan.hearts <= 3;
    const fatalWouldKill = rowan.hearts <= Math.max(0, 2 - rowan.shield);
    if (!shadowWouldKill && markedTargets.length > 1) {
      markedTargets = markedTargets.filter((tid) => tid !== 'rowan');
    }
    if (!fatalWouldKill && fatalTargets.length > 1) {
      fatalTargets = fatalTargets.filter((tid) => tid !== 'rowan');
    }
  }
  // Self-curse-mirror handling: while Athena is cursing Akyros, every point
  // of damage he lands on her mirrors straight back onto him (the mirror
  // still passes through his shield normally, unlike Shadow Execution's own
  // shield-ignoring hit). If she's marked, she'd normally be the preferred
  // attack target below - avoid that unless she's the only living enemy, it
  // secures an outright kill, or there's truly no safer move available.
  const athenaIsCursingRisk = character.special.marks.has('athena')
    && isCursedByLiveAthena(game, character)
    && fatalTargets.includes('athena');
  if (athenaIsCursingRisk) {
    const athena = game.characters['athena'];
    const shadowLegal = !!byId.shadowExecution && markedTargets.includes('athena');
    const bestDamage = shadowLegal ? 3 : 2; // marked Fatal Slash is 2
    const wouldKillAthenaNow = athena.hearts <= Math.max(0, bestDamage - (shadowLegal ? 0 : athena.shield));
    const mirrorSurvivableNow = character.hearts > bestDamage;
    const otherTargets = fatalTargets.filter((tid) => tid !== 'athena');
    // A kill on Athena is only worth taking unconditionally if Akyros
    // actually survives his own mirrored damage - otherwise it's a mutual
    // kill/suicide trade, not a clean win, and should be treated exactly
    // like any other risky hit on her (only accepted once she's truly the
    // last enemy standing, same as the non-lethal case below). Confirmed
    // via a real match: the bot took a "lethal" Shadow Execution on Athena
    // while sitting at 3 hearts from earlier mirror damage, and the
    // mirrored 3 damage KO'd Akyros in the same instant - a needless trade
    // when other living enemies (and thus safer moves) were available.
    if (wouldKillAthenaNow && mirrorSurvivableNow) {
      if (shadowLegal) return { actionId: 'shadowExecution', targetId: 'athena' };
      return { actionId: 'fatalSlash', targetId: 'athena' };
    }
    if (otherTargets.length > 0) {
      // A different living enemy exists - attack or mark them instead of
      // risking the cursed trade with Athena at all.
      const markedOther = otherTargets.find((tid) => character.special.marks.has(tid));
      if (markedOther) return { actionId: 'fatalSlash', targetId: markedOther };
      if (byId.hiddenMark) {
        const markTargets = validTargetsFor(game, character, 'hiddenMark').filter((tid) => tid !== 'athena');
        if (markTargets.length > 0) {
          const targetId = biggestThreatTarget(game, character, markTargets) || lowestHeartsTarget(game, markTargets);
          if (targetId) return { actionId: 'hiddenMark', targetId };
        }
      }
      return { actionId: 'fatalSlash', targetId: pickRandom(otherTargets) };
    }
    // Athena's the only living enemy - take the kill even if it's a mutual
    // trade (still ends the match/removes a threat), and even a non-lethal
    // hit is the only legal move left regardless of survivability, so fall
    // through to the normal attack logic below either way.
  }

  // Shadow Execution secures a kill/heavy hit on an already-marked, weak
  // enemy - use it once one is low enough that -3 ignoring shields matters.
  // Also worth using early against a currently-shielded marked target,
  // since Fatal Slash's marked bonus gets mostly negated by any shield
  // while Shadow Execution ignores it entirely - no point chipping away at
  // a shield with Fatal Slash when the guaranteed-through hit is available.
  if (byId.shadowExecution) {
    // When more than one marked target would actually die to the 3-damage
    // ignore-shield hit, prefer whichever is the bigger active threat over
    // just whoever has the fewest hearts - a kill's a kill either way, so
    // take out whoever's more dangerous first rather than defaulting to the
    // easiest one. Confirmed via a real match: killing an already-doomed
    // 1-heart target instead of a 3-heart target that was actively about to
    // land the finishing blow cost the match - the real threat survived and
    // got the next hit in first.
    const killableMarked = markedTargets.filter((tid) => {
      const t = game.characters[tid];
      return t.hearts <= Math.max(0, 3 - t.shield);
    });
    if (killableMarked.length > 0) {
      const target = biggestThreatTarget(game, character, killableMarked) || lowestHeartsTarget(game, killableMarked);
      return { actionId: 'shadowExecution', targetId: target };
    }
    const weakest = lowestHeartsTarget(game, markedTargets);
    const shieldedTarget = markedTargets.find((tid) => game.characters[tid].shield > 0);
    if (weakest && game.characters[weakest].hearts <= 3) {
      return { actionId: 'shadowExecution', targetId: weakest };
    }
    if (shieldedTarget) {
      return { actionId: 'shadowExecution', targetId: shieldedTarget };
    }
  }
  // Prefer Fatal Slash on an already-marked target for the bonus damage.
  const markedFatalTarget = fatalTargets.find((tid) => character.special.marks.has(tid));
  if (markedFatalTarget) {
    return { actionId: 'fatalSlash', targetId: markedFatalTarget };
  }
  // Otherwise, place a Hidden Mark on an unmarked enemy when one's
  // available (sets up future bonus damage / Shadow Execution), else just
  // Fatal Slash the biggest threat.
  if (byId.hiddenMark) {
    const markTargets = validTargetsFor(game, character, 'hiddenMark');
    const targetId = biggestThreatTarget(game, character, markTargets) || lowestHeartsTarget(game, markTargets);
    if (targetId) return { actionId: 'hiddenMark', targetId };
  }
  return { actionId: 'fatalSlash', targetId: pickDefaultTarget(game, character, 'fatalSlash') };
}

function chooseVeloryaMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Eclipse is a defensive panic button - use it when low on hearts to buy
  // 3 safe attacks, rather than burning it early/randomly.
  if (byId.lunarEclipse && character.hearts <= LOW_HEARTS_THRESHOLD) {
    return { actionId: 'lunarEclipse', targetId: null };
  }
  if (byId.moonstep) {
    const targets = validTargetsFor(game, character, 'moonstep');
    // Hitting a live Athena while she's cursing someone else lands damage
    // on both of them for one action - worth more than the plain
    // different-target bonus alone, so check it first.
    const doubleDip = athenaDoubleDipTarget(game, character, targets);
    // Moonstep's -2 bonus requires a DIFFERENT target than her last attack -
    // prefer whichever valid target isn't lastTargetId to get the bonus.
    const differentTarget = targets.find((tid) => tid !== character.special.lastTargetId);
    const targetId = doubleDip || differentTarget || biggestThreatTarget(game, character, targets) || lowestHeartsTarget(game, targets);
    if (targetId) {
      // If the only target is a live cursing Athena, every point of damage
      // she deals mirrors straight back onto her (both attacks ignore
      // shield, so there's no absorption to soften it either). Once she's
      // low enough that the bigger Moonstep hit (2, from switching targets)
      // would be fatal via the mirror but the smaller flat Lunar Strike (1)
      // would not, take the smaller guaranteed-safe hit instead of risking
      // herself for the marginal extra damage.
      if (targetId === 'athena' && isCursedByLiveAthena(game, character)) {
        const isNewTarget = character.special.lastTargetId !== null && character.special.lastTargetId !== targetId;
        const moonstepDamage = isNewTarget ? 2 : 1;
        if (character.hearts <= moonstepDamage && character.hearts > 1) {
          return { actionId: 'lunarStrike', targetId };
        }
      }
      return { actionId: 'moonstep', targetId };
    }
  }
  return { actionId: 'lunarStrike', targetId: pickDefaultTarget(game, character, 'lunarStrike') };
}

function chooseBladeMove(character, game, usable) {
  // Only one real action - the decision is entirely about target. Staying
  // on the same streak target keeps compounding damage; only switch if
  // that target is no longer valid or a clean kill is available elsewhere.
  const targets = validTargetsFor(game, character, 'bloodHunt');
  if (targets.length === 0) return { actionId: 'bloodHunt', targetId: null };
  const streakTarget = character.special.streakTargetId;
  if (streakTarget && targets.includes(streakTarget)) {
    // A streak locked onto Athena needs its own safety check, separate from
    // pickDefaultTarget's (which this branch bypasses entirely) - Blood
    // Hunt's damage compounds every consecutive hit (1, 2, 3...), so a
    // streak that was perfectly safe when it started can become self-lethal
    // via her curse mirror as it grows, with nothing here ever having
    // checked for that. Same class of bug as Akyros/Zerathys's own cursed-
    // Athena guards: break off the streak (switch target) once continuing
    // it would kill Blade himself through the mirror, unless she's the only
    // living enemy left.
    if (streakTarget === 'athena' && isCursedByLiveAthena(game, character)) {
      const nextStreakDamage = character.special.streakCount + 1;
      const otherTargets = targets.filter((tid) => tid !== 'athena');
      if (character.hearts <= nextStreakDamage && otherTargets.length > 0) {
        return { actionId: 'bloodHunt', targetId: pickDefaultTarget(game, character, 'bloodHunt') };
      }
    }
    // A streak locked onto a Mirror-Reflect-active Rowan takes 3 reflect
    // damage on every single consecutive hit, same compounding-risk shape
    // as the Athena guard just above - break off unless he's the only
    // living target left.
    if (streakTarget === 'rowan' && isMirrorReflectActive(game)) {
      const otherTargets = targets.filter((tid) => tid !== 'rowan');
      if (otherTargets.length > 0) {
        return { actionId: 'bloodHunt', targetId: pickDefaultTarget(game, character, 'bloodHunt') };
      }
    }
    return { actionId: 'bloodHunt', targetId: streakTarget };
  }
  return { actionId: 'bloodHunt', targetId: pickDefaultTarget(game, character, 'bloodHunt') };
}

// Divine Sacrifice is a genuine gamble (guaranteed 3 damage to an enemy,
// but a RANDOM 1-3 hearts lost to herself every single cast, no cooldown,
// can even KO her outright) - two separate justifications for the bot to
// use it, checked in priority order:
// 1. A SURE KILL: target has <=3 hearts (the guaranteed 3 damage KOs them
//    outright) - worth it as long as she'd SURVIVE even the worst-case
//    3-heart self-cost (her own hearts must be > 3), regardless of how
//    comfortable that leaves her, since ending the threat now outweighs
//    the risk. Confirmed live: the bot passed up an actual game-ending
//    kill (enemy at 2 hearts) purely because her own hearts (4) sat under
//    an earlier, stricter flat safety floor that never weighed how much
//    the kill itself was worth.
// 2. SAFE FARMING: no sure kill available, but she's near-full health
//    (ATHENA_SACRIFICE_SAFE_HEARTS) - worth using as regular offense
//    rather than sitting idle re-casting Curse Strike on an already-cursed
//    target for no new effect. Confirmed live: a full-health Athena with
//    nothing else productive to do (curse already applied, no sure kill
//    on the board) still never used it, purely because the "sure kill"
//    case was the ONLY case at all after an earlier fix removed farming
//    entirely - too conservative, left an available high-value action
//    completely unused this whole match.
const ATHENA_SACRIFICE_FINISH_THRESHOLD = 3;
const ATHENA_SACRIFICE_MAX_SELF_COST = 3;
const ATHENA_SACRIFICE_SAFE_HEARTS = 6;

function chooseAthenaMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  if (byId.divineRestore && character.hearts <= LOW_HEARTS_THRESHOLD) {
    return { actionId: 'divineRestore', targetId: null };
  }
  if (byId.divineSacrifice) {
    const allTargets = validTargetsFor(game, character, 'divineSacrifice');
    if (character.hearts > ATHENA_SACRIFICE_MAX_SELF_COST) {
      const sureKills = allTargets.filter((tid) => game.characters[tid].hearts <= ATHENA_SACRIFICE_FINISH_THRESHOLD);
      if (sureKills.length > 0) {
        const targetId = lowestHeartsTarget(game, sureKills) || pickRandom(sureKills);
        return { actionId: 'divineSacrifice', targetId };
      }
    }
    if (character.hearts >= ATHENA_SACRIFICE_SAFE_HEARTS && allTargets.length > 0) {
      const targetId = biggestThreatTarget(game, character, allTargets) || lowestHeartsTarget(game, allTargets) || pickRandom(allTargets);
      return { actionId: 'divineSacrifice', targetId };
    }
  }
  // Curse Strike may not actually be usable right now (no valid target -
  // e.g. everyone else is KO'd or the only remaining enemy is untargetable),
  // in which case fall back to Divine Restore if it's still available
  // rather than firing a curse with no legal target.
  if (byId.curseStrike) {
    const targets = validTargetsFor(game, character, 'curseStrike');
    const currentCursed = character.special.curseTargetCharacterId;
    // Danger override: once she's genuinely at risk of dying soon, re-curse
    // onto whoever's actually been hitting her hardest recently - even if
    // that means abandoning an existing curse she'd normally stay locked
    // onto. The reasoning: if she's about to lose this exchange anyway, a
    // curse on her actual likely killer turns that loss into a mutual KO
    // (a draw) instead of a clean loss, via the curse-mirror firing the
    // instant the killing blow lands. A curse on anyone else just wastes
    // the mirror on a hit that may never come. Confirmed live: she died to
    // Akyros while still cursing an unrelated target from earlier, missing
    // a real chance to at least take her own killer down with her.
    if (character.hearts <= LOW_HEARTS_THRESHOLD) {
      const likelyKiller = biggestThreatTarget(game, character, targets);
      if (likelyKiller && likelyKiller !== currentCursed) {
        return { actionId: 'curseStrike', targetId: likelyKiller };
      }
    }
    // Keep the curse on whoever's already cursed if they're still a legal
    // target - re-picking a new target every turn for no reason just makes
    // the mirror unpredictable and wastes the fact the curse never expires
    // on its own. Only switch when forced (current target invalid/dead) or
    // when a clearly healthier/more dangerous target exists to curse
    // instead - a target with more hearts left can keep attacking Athena
    // for longer, making the eventual mirror damage add up more.
    if (currentCursed && targets.includes(currentCursed)) {
      const healthierOptions = targets.filter((tid) =>
        game.characters[tid].hearts > game.characters[currentCursed].hearts + 2
      );
      return { actionId: 'curseStrike', targetId: pickRandom(healthierOptions) || currentCursed };
    }
    // Prefer whoever's actually been hitting her recently (same
    // biggestThreatTarget signal every other character's targeting uses) -
    // the curse only pays off once the cursed target lands a REAL hit on
    // her, so cursing someone who's never attacked her at all (purely
    // because they happen to have the most hearts) can sit there doing
    // nothing for the whole match if they never do. Confirmed bug report:
    // Athena kept curse-locking onto a character that had never once
    // attacked her, purely on the max-hearts tiebreak below. Max-hearts is
    // now only the fallback for when nobody's attacked her recently at all
    // (early game, or everyone's been ignoring her).
    const threatId = biggestThreatTarget(game, character, targets);
    if (threatId) return { actionId: 'curseStrike', targetId: threatId };
    const maxHearts = Math.max(...targets.map((tid) => game.characters[tid].hearts));
    const tiedBest = targets.filter((tid) => game.characters[tid].hearts === maxHearts);
    const targetId = pickRandom(tiedBest);
    if (targetId) return { actionId: 'curseStrike', targetId };
  }
  if (byId.divineRestore) {
    return { actionId: 'divineRestore', targetId: null };
  }
  return null;
}

function chooseBoingoMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Jester Ball is a coin-flip-shaped social weapon - throw it at the
  // biggest threat so either outcome (they eat -4, or they pass/return it
  // and burn a turn deciding) works in Boingo's favor.
  if (byId.jesterBall) {
    const targets = validTargetsFor(game, character, 'jesterBall');
    const targetId = biggestThreatTarget(game, character, targets) || lowestHeartsTarget(game, targets);
    if (targetId) return { actionId: 'jesterBall', targetId };
  }
  return { actionId: 'chaosGamble', targetId: pickDefaultTarget(game, character, 'chaosGamble') };
}

// Melyssa's own turn is entirely "pick a puppet" - usable is always just
// [{ actionId: 'mindControl', needsTarget: true, validTargetIds: [...] }].
// The actual sub-decision (what the puppet does) is resolved separately,
// AFTER this returns, by chooseBotMelyssaPuppetAction below (called from
// server/index.js's stepBotTurn, mirroring how Soul Swap's own follow-up
// target is chosen in a second step after the initial move).
// Streak count at/above which an enemy Blade's live streak against Melyssa
// is treated as an urgent, forward-looking threat - his NEXT bloodHunt hit
// (if left alone) deals exactly this much damage and would only grow further.
// This deliberately outranks biggestThreatTarget's backward-looking damage
// tally, since a streak of 2+ is a known, escalating future hit, not just a
// historical one.
const BLADE_STREAK_DANGER_THRESHOLD = 2;

// A live enemy Blade with a dangerous streak specifically against Melyssa -
// puppeting him to redirect bloodHunt at a different target resets his
// streak (see server/abilities/blade.js), defusing the escalating threat
// before it lands. Returns Blade's characterId, or null if no such threat
// exists among the given candidate pool.
function bladeStreakThreatAgainstMelyssa(game, melyssaId, candidateIds) {
  for (const tid of candidateIds) {
    const c = game.characters[tid];
    if (c.id === 'blade' && !c.isKO && c.special.streakTargetId === melyssaId
      && c.special.streakCount >= BLADE_STREAK_DANGER_THRESHOLD) {
      return tid;
    }
  }
  return null;
}

// True when Melyssa is critical AND a puppeted Zerathys's Soul Swap would
// be a genuine, meaningful rescue - same "worth it" margin already used
// once he's puppeted (see chooseBotMelyssaPuppetAction's own soulSwap
// check below), just evaluated here BEFORE puppet selection so bot-Melyssa
// actually seeks him out instead of only stumbling onto him via
// biggestThreatTarget/lowestHeartsTarget. Reported directly: a bot
// Melyssa at critical health was seen puppeting other characters instead,
// missing an available Zerathys steal. Checked regardless of ally/enemy -
// Soul Swap helps her either way, unlike every other puppeted kit's value
// which is enemy-targeting-only (that's why this can't just reuse `pool`,
// which narrows to enemies-only whenever any enemy is alive). Requires
// Soul Swap to actually still be usable (his special isn't a repeatable
// move - !usedSpecial) and Melyssa to be a legal PUPPET target for it
// right now (isValidPuppetTarget, not the enemy-only isValidTarget - a
// puppeted Zerathys is allowed to Soul Swap his own ally, same as any
// other puppeted action, per puppetActionsFor's own ally-allowed rule),
// otherwise puppeting him would be a wasted turn.
function zerathysSoulSwapRescueTarget(game, melyssaCharacter, candidateIds) {
  if (melyssaCharacter.hearts > LOW_HEARTS_THRESHOLD) return null;
  for (const tid of candidateIds) {
    const c = game.characters[tid];
    if (c.id === 'zerathys' && !c.isKO && !c.usedSpecial && c.hearts > melyssaCharacter.hearts + 1
      && isValidPuppetTarget(game, tid, 'soulSwap', melyssaCharacter.id)) {
      return tid;
    }
  }
  return null;
}

function chooseMelyssaMove(character, game, usable) {
  const candidates = Object.keys(game.characters).filter((tid) => isValidMindControlTarget(game, tid));
  if (candidates.length === 0) return null; // defensive; shouldn't happen if usable is nonempty
  const rescueId = zerathysSoulSwapRescueTarget(game, character, candidates);
  if (rescueId) return { actionId: 'mindControl', targetId: rescueId };
  // Prefer puppeting an ENEMY (offensive value) over an ally, falling back
  // to an ally only when no enemy candidate exists - puppeting most kits in
  // this roster is inherently offensive regardless of who "holds" it (e.g.
  // Athena's curseStrike/divineRestore can still be aimed usefully even via
  // an ally puppet), so an ally fallback is never wasted, just lower-priority
  // than a genuine enemy puppet.
  const enemyIds = candidates.filter((tid) => game.characters[tid].ownerId !== character.ownerId);
  const allyIds = candidates.filter((tid) => game.characters[tid].ownerId === character.ownerId);
  const pool = enemyIds.length > 0 ? enemyIds : allyIds;
  const bladeThreatId = bladeStreakThreatAgainstMelyssa(game, character.id, pool);
  const puppetId = bladeThreatId
    || biggestThreatTarget(game, character, pool)
    || lowestHeartsTarget(game, pool)
    || pickRandom(pool);
  return { actionId: 'mindControl', targetId: puppetId };
}

// Whichever candidate target has the HIGHEST grudge count currently armed
// against them - the count lives on HER OWN character.special, not on a
// third character's state, so this is a direct lookup rather than a
// cross-character search (unlike e.g. bladeStreakThreatAgainstMelyssa
// above, which has to search for a THIRD character referencing
// melyssaId). Prioritizing the biggest count cashes in the biggest
// available revenge damage first, rather than any grudged target equally.
function grudgedTarget(game, character, targetIds) {
  const counts = character.special.grudgeCounts;
  const grudged = targetIds.filter((tid) => (counts.get(tid) || 0) > 0);
  if (grudged.length === 0) return null;
  const maxCount = Math.max(...grudged.map((tid) => counts.get(tid)));
  const tied = grudged.filter((tid) => counts.get(tid) === maxCount);
  return tied.length === 1 ? tied[0] : (biggestThreatTarget(game, character, tied) || pickRandom(tied));
}

// Kaelis's own cast threshold for Call Ashka - deliberately 1 higher than
// the shared LOW_HEARTS_THRESHOLD (3) used elsewhere (Athena/Velorya/
// Melyssa's own critical-health checks). Her heal is spread out over 3
// turns rather than landing all at once, so she needs to start it earlier
// to have any chance of the later ticks actually saving her.
const KAELIS_ASHKA_THRESHOLD = 4;

function chooseKaelisMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Cast Call Ashka when critical - securing the heal-over-turns before
  // it's too late outranks a normal Grudge Strike that turn.
  if (byId.callAshka && character.hearts <= KAELIS_ASHKA_THRESHOLD) {
    return { actionId: 'callAshka', targetId: null };
  }
  const targets = validTargetsFor(game, character, 'grudgeStrike');
  // Cashing in a grudge (double damage) takes priority over the generic
  // threat/lowest-hearts chain, same "specific check before generic
  // fallback" ordering bladeStreakThreatAgainstMelyssa/
  // zerathysSoulSwapRescueTarget already establish.
  const targetId = grudgedTarget(game, character, targets)
    || biggestThreatTarget(game, character, targets)
    || lowestHeartsTarget(game, targets)
    || pickRandom(targets);
  return { actionId: 'grudgeStrike', targetId };
}

function chooseDraxusMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Cast Deathless Fury when meaningfully hurt but BEFORE he's already on
  // the verge of dying - unlike Call Ashka/Divine Restore's critical-only
  // gating, the payoff here (become unkillable, then land 3 strikes) is
  // worth banking early, not held back until he's nearly dead already.
  if (byId.deathlessFury && character.hearts <= LOW_HEARTS_THRESHOLD) {
    return { actionId: 'deathlessFury', targetId: null };
  }
  const targets = validTargetsFor(game, character, 'dyingBlow');
  const targetId = biggestThreatTarget(game, character, targets)
    || lowestHeartsTarget(game, targets)
    || pickRandom(targets);
  return { actionId: 'dyingBlow', targetId };
}

// True if any OTHER character currently has an ACTIVELY HARMFUL status
// placed on Rowan - one that's costing him something every turn it stays up
// (poison ticks, an active silence lock, an active freeze, or Athena's
// curse mirroring damage back at whoever hits her). Worth cleansing
// regardless of his current health, same "the bleeding needs to stop
// before it matters how much blood is left" reasoning as any other
// immediate-threat check in this file.
function rowanHasUrgentNegativeStatus(game, character) {
  return Object.values(game.characters).some((c) => {
    if (c.id === character.id) return false;
    const s = c.special;
    if (!s) return false;
    if (s.curseTargetCharacterId === character.id) return true;
    if (s.freezeActive && s.freezeTargetId === character.id) return true;
    if (s.poisonTargets?.has(character.id)) return true;
    if (s.silenceTargets?.has(character.id)) return true;
    return false;
  });
}

// True whenever a live Blade has his Blood Hunt streak locked onto Rowan
// with real momentum behind it (2+ means his NEXT hit deals 3+, since
// streakCount tracks the damage his last hit dealt and each consecutive
// hit adds 1 more) - unlike a fresh 1-count streak, which is just a normal
// attack and not yet worth reacting to specially. Purify wipes the streak-
// lock outright (see purify.execute's streakTargetId clear in rowan.js),
// forcing Blade back to a cold 1-damage opener next time he attacks
// instead of letting the compounding damage keep snowballing.
function rowanFacingGrowingBladeStreak(game, character) {
  const blade = game.characters['blade'];
  return !!(blade && !blade.isKO && blade.special.streakTargetId === character.id
    && blade.special.streakCount >= 2);
}

// A minor status (Kaelis grudge count, Akyros mark, Blade's streak-lock)
// costs Rowan nothing on its own right now - a mark does nothing until a
// Fatal Slash/Shadow Execution actually lands, grudge only matters once
// Kaelis retaliates - so it's deliberately NOT checked here at all.
// Confirmed bug report: the bot was burning its one-time Purify at 6/7
// hearts purely because a trivial status like this was present. It's still
// worth cleansing eventually, but only as a side effect of Purify firing
// for a REAL reason (badly hurt, or an actively harmful status above) -
// never as its own trigger while he's healthy.

// True whenever it's worth holding Poison Cloud/Silence Lock in reserve for
// Chronox specifically, rather than spending them on whoever's convenient
// right now. Chronox's permanent Chrono Guard shield (reset to 1 every one
// of his own turns) fully absorbs Rowan's only reliable repeatable damage
// (Wand Strike's flat 1, and a fully-shielded Wild Lightning roll of 1) -
// if the match narrows down to just the two of them, a Rowan who already
// burned poison/silence on someone else has no real way to ever land
// meaningful damage on him. Only applies while a THIRD living enemy still
// exists to eventually soak those two spells instead - once it's already a
// Rowan-vs-Chronox 1v1, there's nothing left to save them for, so the
// normal "use it now" priority takes back over via the isFinalDuel escape
// hatch below. Also stands down once Chronox is already poisoned/silenced
// (nothing left to reserve) or dead (nothing to reserve FOR).
function shouldReserveForChronox(game, character) {
  const chronox = game.characters['chronox'];
  if (!chronox || chronox.isKO || chronox.untargetable) return false;
  const others = livingEnemies(game, character).filter((c) => c.id !== 'chronox');
  if (others.length === 0) return false; // already the 1v1 - nothing left to wait for
  const alreadyPoisoned = character.special.poisonTargets.has('chronox');
  const alreadySilenced = character.special.silenceTargets.has('chronox');
  return !alreadyPoisoned || !alreadySilenced;
}

// True whenever it's worth holding Poison Cloud in reserve for Marin
// specifically, rather than spending it on whoever's convenient right now.
// Her kit is essentially all permanent upside with no downside anywhere
// (Everbloom/Threefold Veil/Piercing Wand/Wand Mastery all auto-activate
// for free, Clean Slate cleanses most status effects at no cost) - a
// straight 1v1 against her is genuinely tough for Rowan since Wand Strike
// alone rarely outraces her free sustain/defense. Poison Cloud is his one
// reliable answer that Clean Slate can no longer touch (confirmed scope
// decision - Clean Slate does not cover Poison Cloud), so it's worth
// saving specifically for her rather than burning it on a lesser threat.
// Same reserve shape as Chronox above: only applies while a THIRD living
// enemy still exists to soak it instead - once it's already a Rowan-vs-
// Marin 1v1, there's nothing left to wait for, so normal priority takes
// over. Stands down once she's already poisoned or dead.
function shouldReserveForMarin(game, character) {
  const marin = game.characters['marin'];
  if (!marin || marin.isKO || marin.untargetable) return false;
  const others = livingEnemies(game, character).filter((c) => c.id !== 'marin');
  if (others.length === 0) return false; // already the 1v1 - nothing left to wait for
  return !character.special.poisonTargets.has('marin');
}

// True whenever a hurt, live Zerathys still has Soul Swap banked
// (!usedSpecial) while Rowan himself is comfortably healthy - the exact
// setup where Soul Swap is most dangerous to let sit: it trades hearts
// pools outright, so a low Zerathys swapping into a high Rowan instantly
// undoes however much damage Rowan has already landed on him. Locking it
// down with Silence Lock removes that escape hatch entirely rather than
// leaving it banked for whenever Zerathys decides to cash it in.
function rowanFacingBankedSoulSwap(game, character) {
  const zerathys = game.characters['zerathys'];
  if (!zerathys || zerathys.isKO || zerathys.usedSpecial) return false;
  return character.hearts > LOW_HEARTS_THRESHOLD && zerathys.hearts <= LOW_HEARTS_THRESHOLD;
}

// True whenever a low-health, live Draxus still has Deathless Fury banked
// (!usedSpecial) - his real threat isn't the cast itself (it only floors
// his NEXT hit at 1 heart instead of KO'ing him, no immediate damage), it's
// the bonus 3-strike turn it grants right after: each Dying Blow deals up
// to 3 damage depending on his OWN low hearts at the time, so a full bonus
// turn can land as much as 9 damage in one go. Gated on his hearts already
// being low, same as the real cast timing (he has no reason to pop it at
// full health - Deathless Fury does nothing there), which also happens to
// be exactly when his own Dying Blow damage tier is at its highest, making
// the eventual bonus turn most dangerous. Silence Lock denies the special
// action outright before he ever gets the chance to bank the death-proof
// window and the strikes that follow it.
function rowanFacingBankedDeathlessFury(game, character) {
  const draxus = game.characters['draxus'];
  if (!draxus || draxus.isKO || draxus.usedSpecial) return false;
  return draxus.hearts <= LOW_HEARTS_THRESHOLD;
}

// True whenever a healthy, live, not-yet-poisoned Kaelis is a legal Poison
// Cloud target - she's the one Poison Cloud can be cast on with essentially
// no downside: the recurring ticks don't add to her grudge counter (only
// the initial cast does, a single point - see the isPoisonTick exclusion
// in damagePipeline.js/the one-time grudge add in poisonCloud.execute), so
// starting the DoT early against her costs nothing extra and gets the most
// total ticks out of it over the rest of the match. Gated on her being
// healthy specifically because a low-health Kaelis is better served by a
// more IMMEDIATE spell (Wild Lightning/a kill) - poison's slow bleed
// matters most when there's a long runway of her own turns left for it to
// tick through.
function rowanFacingHealthyKaelis(game, character) {
  const kaelis = game.characters['kaelis'];
  if (!kaelis || kaelis.isKO || kaelis.untargetable) return false;
  if (character.special.poisonTargets.has('kaelis')) return false;
  return kaelis.hearts > LOW_HEARTS_THRESHOLD;
}

function chooseRowanMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  const reserveForChronox = shouldReserveForChronox(game, character);
  const reserveForMarin = shouldReserveForMarin(game, character);
  // Purify: cast immediately if he's carrying anything ACTIVELY harmful
  // (poison, live silence/freeze, Athena's curse) regardless of health, or
  // if he's simply badly hurt (heal-to-full is worth it on its own at that
  // point, and it also happens to sweep up any lingering MINOR status like
  // a grudge/mark/streak-lock for free). A merely minor status on its own,
  // at high health, is NOT worth burning the one-time cast on by itself.
  // Same "safety valve takes priority" reasoning as Kaelis's Call Ashka /
  // Athena's Divine Restore gating elsewhere here.
  const badlyHurt = character.hearts <= LOW_HEARTS_THRESHOLD;
  if (byId.purify && (
    rowanHasUrgentNegativeStatus(game, character)
    || badlyHurt
    || rowanFacingGrowingBladeStreak(game, character)
  )) {
    return { actionId: 'purify', targetId: null };
  }
  // Mirror Reflect: cast it as soon as it's available and not already
  // active, regardless of health - since the fix making it persist until
  // it actually triggers (rather than expiring at his own next turn), there
  // is zero downside to putting it up immediately rather than waiting for a
  // "need it now" moment that might never come. Getting it up early also
  // means bot AI's Mirror Reflect avoidance (isMirrorReflectActive in this
  // file) kicks in sooner, visibly deterring other bots from attacking him
  // for the rest of the match instead of only defending a single late hit.
  if (byId.mirrorReflect && !character.special.mirrorReflectActive) {
    return { actionId: 'mirrorReflect', targetId: null };
  }
  // Already-discovered spells take priority over MORE studying - Arcane
  // Study only pays off once its reveal actually resolves next turn, while
  // a known spell does something useful right now. Confirmed via a real
  // match report: the bot kept re-casting Arcane Study turn after turn even
  // with a full kit already discovered, instead of actually using it.
  // Silence Lock on whoever still has their own special banked - denies
  // the single biggest threat a character can pose. While reserving for
  // Chronox, only cast this on HIM (if he's a legal target and not already
  // silenced) - otherwise skip it entirely this turn rather than spending
  // it on someone else, so it's still available once he's the one who
  // matters.
  if (byId.silenceLock) {
    const targets = validTargetsFor(game, character, 'silenceLock')
      .filter((tid) => !game.characters[tid].usedSpecial);
    if (reserveForChronox) {
      if (targets.includes('chronox') && !character.special.silenceTargets.has('chronox')) {
        return { actionId: 'silenceLock', targetId: 'chronox' };
      }
    } else if (targets.includes('draxus') && !character.special.silenceTargets.has('draxus')
      && rowanFacingBankedDeathlessFury(game, character)) {
      return { actionId: 'silenceLock', targetId: 'draxus' };
    } else if (targets.includes('zerathys') && !character.special.silenceTargets.has('zerathys')
      && rowanFacingBankedSoulSwap(game, character)) {
      return { actionId: 'silenceLock', targetId: 'zerathys' };
    } else if (targets.length > 0) {
      const targetId = biggestThreatTarget(game, character, targets) || pickRandom(targets);
      return { actionId: 'silenceLock', targetId };
    }
  }
  // Wild Lightning next - highest damage ceiling of anything in the kit.
  // Unaffected by the Chronox reserve - it still does real (if shield-
  // reduced) damage to him, unlike Wand Strike, so there's no reason to
  // hold it back the same way.
  if (byId.wildLightning) {
    const targets = validTargetsFor(game, character, 'wildLightning');
    const targetId = biggestThreatTarget(game, character, targets)
      || lowestHeartsTarget(game, targets) || pickRandom(targets);
    return { actionId: 'wildLightning', targetId };
  }
  // Poison Cloud on a fresh (not-yet-poisoned) target - no point stacking
  // it on someone already ticking. Same Chronox-reserve treatment as
  // Silence Lock above: only cast it on him while reserving, skip
  // otherwise rather than spending it on a target that doesn't need it.
  if (byId.poisonCloud) {
    const targets = validTargetsFor(game, character, 'poisonCloud')
      .filter((tid) => !character.special.poisonTargets.has(tid));
    if (reserveForChronox) {
      if (targets.includes('chronox')) {
        return { actionId: 'poisonCloud', targetId: 'chronox' };
      }
    } else if (reserveForMarin) {
      if (targets.includes('marin')) {
        return { actionId: 'poisonCloud', targetId: 'marin' };
      }
    } else if (targets.includes('kaelis') && rowanFacingHealthyKaelis(game, character)) {
      return { actionId: 'poisonCloud', targetId: 'kaelis' };
    } else if (targets.length > 0) {
      const targetId = biggestThreatTarget(game, character, targets) || pickRandom(targets);
      return { actionId: 'poisonCloud', targetId };
    }
  }
  // Nothing currently discovered is worth using this turn (either nothing's
  // been found yet, or every known spell above had no valid/fresh target) -
  // Arcane Study has no downside beyond its own cooldown, so fall back to
  // building out the toolkit instead of just throwing a plain Wand Strike.
  if (byId.arcaneStudy) {
    return { actionId: 'arcaneStudy', targetId: null };
  }
  const targets = validTargetsFor(game, character, 'wandStrike');
  const targetId = biggestThreatTarget(game, character, targets)
    || lowestHeartsTarget(game, targets) || pickRandom(targets);
  return { actionId: 'wandStrike', targetId };
}

// Marin's entire kit auto-activates the instant Arcane Study reveals it -
// unlike Rowan, there is no separate cast decision for any of her 5
// spells, so there's nothing to weigh against Arcane Study the way
// Rowan's chooser weighs "use a known spell now vs. study for another."
// The only real decisions left are: study whenever there's still
// something to discover (always worth it, no downside beyond the 1-turn
// cooldown - identical reasoning to Rowan's own "no downside" Arcane
// Study fallback), and who Wand Strike hits otherwise.
function chooseMarinMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  if (byId.arcaneStudy) {
    return { actionId: 'arcaneStudy', targetId: null };
  }
  const targets = validTargetsFor(game, character, 'wandStrike');
  const targetId = biggestThreatTarget(game, character, targets)
    || lowestHeartsTarget(game, targets) || pickRandom(targets);
  return { actionId: 'wandStrike', targetId };
}

// Grimtal has no real decisions to weigh: Grim Strike is his only repeatable
// damage move (no situational alternative to hold it back for), Grim Ward is
// fully passive with no button at all, and Skull Crack has no downside
// beyond its own 3-use cap - always worth firing on the biggest threat
// whenever it's available, same "no downside, no reason to hold it" logic
// as Rowan's Arcane Study fallback.
function chooseGrimtalMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Claim the Kill first whenever available - pure permanent upside (a
  // banked unclaimed kill never expires, but claiming it now means every
  // FUTURE Grim Strike hits harder starting immediately) with no downside
  // beyond the one turn it costs, same "no reason to hold it" reasoning as
  // Rowan's Arcane Study fallback.
  if (byId.claimKill) {
    return { actionId: 'claimKill', targetId: null };
  }
  if (byId.skullCrack) {
    const targets = validTargetsFor(game, character, 'skullCrack');
    const targetId = biggestThreatTarget(game, character, targets) || lowestHeartsTarget(game, targets) || pickRandom(targets);
    return { actionId: 'skullCrack', targetId };
  }
  const targets = validTargetsFor(game, character, 'grimStrike');
  const targetId = biggestThreatTarget(game, character, targets) || lowestHeartsTarget(game, targets) || pickRandom(targets);
  return { actionId: 'grimStrike', targetId };
}

// Illyra's own decision has two parts: Mirage Burst detonates EVERY
// currently-marked enemy at once (not a single chosen target), so stacks
// never expire on their own - the real risk isn't "waiting too long," it's
// a marked target dying to someone ELSE's hit first and wasting whatever
// was banked on them entirely (confirmed live: 2 stacks on Draxus sat
// through a Blood Hunt + Divine Sacrifice combo that nearly finished him,
// while she kept stacking instead of cashing in). Two triggers, checked in
// order:
// 1. URGENCY: any marked target whose current hearts have dropped to or
//    below their OWN stack count on them - a rough "this stack is now at
//    real risk of being wasted" signal (their hearts are already low
//    enough that another attacker's next hit plausibly finishes them
//    before Illyra's next turn) - bursts immediately regardless of the
//    total, securing whatever value is banked rather than gambling on a
//    bigger total that might never arrive.
// 2. PATIENT THRESHOLD: with no urgent target, the minimum COMBINED total
//    worth spending the turn on scales with how many characters are still
//    alive - more players alive means more attackers who could steal a
//    marked target's stacks by killing them first, so she bursts sooner
//    (lower total) to reduce that exposure; fewer alive means less of that
//    risk, so she can afford to let stacks build higher before cashing in.
const ILLYRA_BURST_THRESHOLD_BY_ALIVE = { 4: 2, 3: 3, 2: 4 };

function illyraUrgentBurstTarget(character, game) {
  for (const [tid, count] of character.special.mirageMarks) {
    if (count <= 0) continue;
    const target = game.characters[tid];
    if (target && !target.isKO && target.hearts <= count) return tid;
  }
  return null;
}

function chooseIllyraMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  // Mirage Overload: no downside to casting it the instant it's legal
  // (hearts <= 3, one-time use, 0 direct damage/cost to her) - top
  // priority even above her usual Mirage Burst threshold check below,
  // since she's already in genuine danger at that hearts range and this
  // is pure free value (scattered stacks she can cash in with a later
  // Burst). No target to choose - the distribution is server-side random.
  if (byId.mirageOverload) {
    return { actionId: 'mirageOverload', targetId: null };
  }
  if (byId.mirageBurst) {
    if (illyraUrgentBurstTarget(character, game)) {
      return { actionId: 'mirageBurst', targetId: null };
    }
    let total = 0;
    for (const count of character.special.mirageMarks.values()) total += count;
    const aliveCount = Object.values(game.characters).filter((c) => !c.isKO).length;
    const threshold = ILLYRA_BURST_THRESHOLD_BY_ALIVE[aliveCount] ?? 2;
    if (total >= threshold) {
      return { actionId: 'mirageBurst', targetId: null };
    }
  }
  const targets = validTargetsFor(game, character, 'mirageMark');
  // Concentrate marks on whoever ALREADY has the most stacks, rather than
  // chasing "whoever's been attacking me most recently" every turn (the
  // generic biggestThreatTarget heuristic every other character's basic
  // attack uses) - confirmed live report: her bot was noticeably weaker
  // than human play specifically because it kept scattering marks across
  // whichever enemy happened to hit her that particular cycle, instead of
  // deliberately building one big stack on a single chosen target the way
  // an obvious human strategy would. Only falls back to the generic
  // threat-based pick when she has nothing marked anywhere yet (a genuine
  // fresh choice, no existing investment to protect).
  const marks = character.special.mirageMarks;
  let stackTarget = null;
  let stackCount = 0;
  for (const tid of targets) {
    const count = marks.get(tid) || 0;
    if (count > stackCount) {
      stackCount = count;
      stackTarget = tid;
    }
  }
  const targetId = stackTarget || biggestThreatTarget(game, character, targets) || lowestHeartsTarget(game, targets) || pickRandom(targets);
  return { actionId: 'mirageMark', targetId };
}

// Oraclus's Rune Vision, stage 1 (picking the predicted ATTACKER). No
// downside to a wrong guess (confirmed ruling - "nothing happens, just a
// wasted turn"), so the bot predicts eagerly whenever it's legal, rather
// than reserving it for only "safe" moments the way other risk-averse
// choosers do. Picks whichever living character (other than himself) is
// MOST likely to actually attack next - approximated as whoever has the
// most usable damaging actions available right now (a rough proxy for "not
// frozen/locked/out of options"), falling back to a random living pick if
// that's tied or unclear.
function chooseRuneVisionAttackerPick(character, game) {
  const candidates = Object.values(game.characters).filter(
    (c) => c.id !== character.id && !c.isKO && !c.untargetable
  );
  if (candidates.length === 0) return null;
  const scored = candidates.map((c) => {
    const usableCount = getUsableActions(c, game).filter((a) => a.needsTarget).length;
    return { id: c.id, usableCount };
  });
  const maxUsable = Math.max(...scored.map((s) => s.usableCount));
  const tied = scored.filter((s) => s.usableCount === maxUsable).map((s) => s.id);
  return pickRandom(tied);
}

// Stage 2 (picking the predicted TARGET), given the attacker already
// chosen above. Predicts that attacker will go after the lowest-hearts
// living character (excluding the attacker themself, already impossible
// via isValidRuneVisionTargetPick) - the same "focus the weakest" default
// heuristic every other character's basic-attack targeting falls back to,
// since it's the single most common real attack pattern across the bot
// roster.
export function chooseRuneVisionTargetPick(character, game, predictedAttackerId) {
  const candidates = Object.values(game.characters)
    .filter((c) => c.id !== predictedAttackerId && !c.isKO && !c.untargetable)
    .map((c) => c.id);
  if (candidates.length === 0) return null;
  return lowestHeartsTarget(game, candidates) || pickRandom(candidates);
}

function chooseOraclusMove(character, game, usable) {
  const byId = Object.fromEntries(usable.map((a) => [a.actionId, a]));
  if (byId.runeVision) {
    const attackerId = chooseRuneVisionAttackerPick(character, game);
    if (attackerId) return { actionId: 'runeVision', targetId: attackerId };
  }
  const targets = validTargetsFor(game, character, 'runeStrike');
  const targetId = lowestHeartsTarget(game, targets) || pickRandom(targets);
  return { actionId: 'runeStrike', targetId };
}

const MOVE_CHOOSERS = {
  tharox: chooseTharoxMove,
  zerathys: chooseZerathysMove,
  chronox: chooseChronoxMove,
  akyros: chooseAkyrosMove,
  velorya: chooseVeloryaMove,
  blade: chooseBladeMove,
  athena: chooseAthenaMove,
  boingo: chooseBoingoMove,
  melyssa: chooseMelyssaMove,
  kaelis: chooseKaelisMove,
  draxus: chooseDraxusMove,
  rowan: chooseRowanMove,
  marin: chooseMarinMove,
  grimtal: chooseGrimtalMove,
  illyra: chooseIllyraMove,
  oraclus: chooseOraclusMove,
};

// Fallback for characters without bot logic yet: picks a random usable
// action and a sensible (lowest-hearts) target rather than a fully random
// target, so early testing isn't dragged down by nonsensical fallback play.
function chooseFallbackMove(character, game, usable) {
  const action = usable[Math.floor(Math.random() * usable.length)];
  if (!action.needsTarget) return { actionId: action.actionId, targetId: null };
  return { actionId: action.actionId, targetId: pickDefaultTarget(game, character, action.actionId) };
}

export function chooseBotMove(character, game) {
  const usable = getUsableActions(character, game);
  if (usable.length === 0) return null;
  const chooser = MOVE_CHOOSERS[character.id] || chooseFallbackMove;
  const move = chooser(character, game, usable);
  if (!move) return chooseFallbackMove(character, game, usable);
  // Safety net: a per-character chooser can return an action that isn't
  // actually in `usable` (e.g. it always falls back to a specific action
  // without checking whether that action currently has a valid target -
  // this has happened for real, producing a "Curse Strike on null" or
  // "Thunder Wrath on null" move). Re-route through the generic fallback
  // whenever that happens, rather than letting an illegal move through.
  const usableEntry = usable.find((a) => a.actionId === move.actionId);
  if (!usableEntry) {
    return chooseFallbackMove(character, game, usable);
  }
  if (move.targetId === null && usableEntry.needsTarget) {
    return { actionId: move.actionId, targetId: pickDefaultTarget(game, character, move.actionId) };
  }
  return move;
}

// Chooses what a bot-controlled Melyssa's puppeted turn actually does,
// given the puppet she already committed to (see chooseMelyssaMove).
// Handles the ball-holder forced choice and the no-real-action fallback
// (Self Choke), otherwise delegates to the puppet's OWN real bot chooser -
// every existing choose*Move function is a pure function of
// (character, game, usable) with no assumption about whose turn it "really"
// is, so calling MOVE_CHOOSERS[puppet.id] here with the puppet's own
// character object is safe and reuses each character's full bot
// intelligence rather than duplicating 8 separate decision trees.
export function chooseBotMelyssaPuppetAction(puppetCharacter, game, melyssaId) {
  const jb = game.jesterBall;
  if (jb && jb.holderCharacterId === puppetCharacter.id) {
    // chooseBotJesterBallMove decides Pass-vs-Take from the HOLDER's own
    // interest (dodge the -4 by passing it off onto someone else) - backed
    // by the same "puppeted decisions serve Melyssa, not the puppet"
    // reasoning as the Zerathys/Blade overrides below. A pass just
    // relocates the damage onto whoever the ball lands on next, which does
    // nothing for Melyssa if her actual target was THIS puppet - forcing
    // Take instead lands the -4 hit directly on the character she's
    // puppeting, right now. Exception: Zerathys with a live Soul Swap combo
    // pending already independently resolves to Take for a different (and
    // better) reason - zerathysBallComboTarget primes an immediate heart-
    // swap follow-up - so defer to the normal logic there rather than
    // overriding it for no benefit. zerathysBallComboTarget's own
    // heartsAfterTake<=0 guard means a genuinely suicidal Take is never
    // chosen through that path either.
    const zerathysComboPending = puppetCharacter.id === 'zerathys' && !!zerathysBallComboTarget(puppetCharacter, game);
    if (!zerathysComboPending) {
      return { kind: 'jesterBall', choice: 'take' };
    }
    const move = chooseBotJesterBallMove(puppetCharacter, game);
    return { kind: 'jesterBall', choice: move.choice, targetId: move.targetId };
  }
  const usable = getUsableActions(puppetCharacter, game);
  if (usable.length === 0) {
    // No real action available - Self Choke is the only option. In
    // practice this should be unreachable (every living, non-frozen
    // character in the roster always has at least a base attack legal),
    // kept as a defensive fallback rather than assumed impossible.
    return { kind: 'selfChoke' };
  }
  // Puppeted Zerathys needs his OWN dedicated Soul Swap decision, not
  // chooseZerathysMove's normal one - that function decides "is this swap
  // worth it" from ZERATHYS's own perspective (only swaps if the target
  // has meaningfully MORE hearts than HIM), which is backwards once he's
  // puppeted: the swap should be judged by whether it helps MELYSSA.
  // Left unchecked, a puppeted Zerathys would refuse to Soul Swap Melyssa
  // even when she's critically low and he's healthy - exactly the winning
  // combo a human player can already pull off manually (puppet Zerathys,
  // Soul Swap onto herself, redirect his own forced Wrath follow-up back
  // at herself too), silently unavailable to the bot. Checked BEFORE the
  // normal chooser so it takes priority over his own kill-securing/
  // mutual-kill logic whenever it applies - a puppeted turn serves
  // Melyssa's interests, not his. The automatic Wrath follow-up (see
  // stepBotMindControlTurn in index.js) already independently excludes
  // Melyssa's own side via chooseSoulSwapWrathTarget's excludeOwnerId
  // param, so it needs no special handling here.
  const melyssa = melyssaId ? game.characters[melyssaId] : null;
  if (puppetCharacter.id === 'zerathys' && melyssa && !melyssa.isKO && !puppetCharacter.usedSpecial) {
    // isValidPuppetTarget (ally-allowed), not validTargetsFor/isValidTarget
    // (enemy-only) - a puppeted Zerathys is allowed to Soul Swap his own
    // ally, same as puppetActionsFor's own ally-allowed rule for every
    // other puppeted action (e.g. puppeted Blade attacking his own
    // teammate). Using the enemy-only check here meant this whole rescue
    // combo silently never fired whenever Zerathys happened to be on
    // Melyssa's own side that match.
    const canTargetMelyssa = isValidPuppetTarget(game, puppetCharacter.id, 'soulSwap', melyssa.id);
    // Same "meaningfully better" margin chooseZerathysMove itself uses
    // (>1 heart difference), just evaluated for HER pool instead of his.
    if (canTargetMelyssa && puppetCharacter.hearts > melyssa.hearts + 1) {
      return { kind: 'realAction', actionId: 'soulSwap', targetId: melyssa.id };
    }
  }

  // Puppeted Blade needs his OWN dedicated target decision too, for the
  // exact same reason as Zerathys above: chooseBladeMove (see its own
  // comments) deliberately STAYS on an existing streak target whenever
  // it's still valid - correct for his own real turn, but backwards here.
  // The entire point of bot-Melyssa choosing to puppet a Blade who has a
  // dangerous streak against her (see bladeStreakThreatAgainstMelyssa in
  // chooseMelyssaMove) is to break that streak by redirecting his attack
  // elsewhere - left unchecked, the normal chooser would just re-lock onto
  // her again, wasting the puppeted turn and leaving the threat intact.
  if (puppetCharacter.id === 'blade' && melyssa && puppetCharacter.special.streakTargetId === melyssa.id
    && puppetCharacter.special.streakCount >= 1 && usable.some((a) => a.actionId === 'bloodHunt')) {
    const targets = validTargetsFor(game, puppetCharacter, 'bloodHunt').filter((tid) => tid !== melyssa.id);
    if (targets.length > 0) {
      // Redirecting resets his streak to 1 against whoever is picked (see
      // bloodHunt's execute in blade.js) - any legal target off Melyssa's
      // side defuses the threat, so just take the best remaining target by
      // the same priority pickDefaultTarget itself uses (focus fire >
      // biggest recent threat > lowest hearts), restricted to this pool.
      const redirectTarget = focusFireTarget(game, targets) || biggestThreatTarget(game, puppetCharacter, targets)
        || lowestHeartsTarget(game, targets) || pickRandom(targets);
      return { kind: 'realAction', actionId: 'bloodHunt', targetId: redirectTarget };
    }
  }

  const chooser = MOVE_CHOOSERS[puppetCharacter.id] || chooseFallbackMove;
  let move = chooser(puppetCharacter, game, usable);
  if (!move) move = chooseFallbackMove(puppetCharacter, game, usable);
  // Same safety net as chooseBotMove's own post-processing above.
  const usableEntry = usable.find((a) => a.actionId === move.actionId);
  if (!usableEntry) move = chooseFallbackMove(puppetCharacter, game, usable);
  if (move.targetId === null && usableEntry?.needsTarget) {
    move = { actionId: move.actionId, targetId: pickDefaultTarget(game, puppetCharacter, move.actionId) };
  }

  // Self Choke check: chooser() above only knows the puppet's own
  // perspective, so an enemy puppet's "best" real move is always aimed AT
  // Melyssa's side (there's no one else for it to attack) - left
  // unchecked, a bot Melyssa would puppet the last enemy into repeatedly
  // attacking herself/her allies forever, never taking the guaranteed-safe
  // Self Choke kill instead (this is exactly what was observed in a real
  // match: Melyssa at 7 hearts lost to a 1-heart Velorya because her bot
  // kept puppeting Velorya's Moonstep onto herself). Only relevant for an
  // ENEMY puppet - Self Choke isn't offered at all for an ally puppet.
  // (melyssa itself is already declared above, for the Soul Swap check.)
  const isEnemyPuppet = melyssa && puppetCharacter.ownerId !== melyssa.ownerId;
  if (isEnemyPuppet) {
    const chosenTarget = move.targetId ? game.characters[move.targetId] : null;
    const hitsMelyssaSide = chosenTarget && chosenTarget.ownerId === melyssa.ownerId;
    // A puppeted setup move (Zerathys's Charge Up, Tharox's Titan Toss -
    // anything with no target and no damage this turn) deals zero progress
    // right now, banking on a LATER puppeted turn to cash in a bigger hit -
    // a turn Melyssa has no guarantee of ever getting again (the enemy
    // could die, change targets, or simply not get puppeted again). Self
    // Choke's guaranteed 1 damage this turn is strictly better than a
    // payoff that may never arrive, so prefer it over any move that does
    // nothing this turn - reported live: Melyssa puppeting Zerathys into
    // Charge Up in a 1v1 instead of choking him down immediately.
    const dealsNoDamageThisTurn = !usableEntry?.needsTarget && move.actionId !== 'soulSwap';
    // Self Choke always deals exactly 1 flat, ignoresShield damage (see
    // executeSelfChoke in index.js) - safe to hardcode that amount here
    // rather than importing the ability module just to read a constant.
    const selfChokeWouldKill = puppetCharacter.hearts <= 1;
    // Lone-duel stall guard (see isMelyssaLoneDuel's own comment in
    // turnEngine.js): with only Melyssa and this one enemy left, Athena's
    // Curse Strike is the one remaining zero-damage move that
    // dealsNoDamageThisTurn misses above (it DOES have a target, it just
    // never deals damage itself - see athena.js) - repeated every turn,
    // this alone can stall the match forever. Named explicitly rather than
    // inferred, since it's the only targeted-but-harmless action in the
    // roster right now. Zerathys is exempted - his Soul Swap is a genuine
    // advantage play, not a stall.
    const isLoneDuelStall = !LONE_DUEL_EXCEPTIONS.has(puppetCharacter.id)
      && isMelyssaLoneDuel(game, melyssaId)
      && move.actionId === 'curseStrike';
    if (selfChokeWouldKill || hitsMelyssaSide || dealsNoDamageThisTurn || isLoneDuelStall) {
      return { kind: 'selfChoke' };
    }
  }

  return { kind: 'realAction', actionId: move.actionId, targetId: move.targetId };
}

// True if Zerathys, after eating the Jester Ball's -4 damage, would have a
// live enemy Soul Swap target with meaningfully more hearts than his
// post-damage total - i.e. deliberately Taking the ball sets up a
// Take-then-Soul-Swap combo: the -4 gets erased (and then some) by
// immediately swapping his low hearts for the target's high pool, leaving
// the target crippled instead. Only worth it if Soul Swap is still
// available at all (isLegal already checks !usedSpecial elsewhere, but this
// runs before any action is chosen, so check the flag directly here).
function zerathysBallComboTarget(character, game) {
  if (character.id !== 'zerathys' || character.usedSpecial) return null;
  const heartsAfterTake = Math.max(0, character.hearts - 4);
  if (heartsAfterTake <= 0) return null; // Take would KO him - no combo to set up
  const targets = Object.keys(game.characters).filter((tid) => isValidTarget(game, character.id, 'soulSwap', tid));
  const maxHearts = targets.length > 0 ? Math.max(...targets.map((tid) => game.characters[tid].hearts)) : 0;
  const tiedBest = targets.filter((tid) => game.characters[tid].hearts === maxHearts);
  const best = pickRandom(tiedBest);
  if (best && game.characters[best].hearts > heartsAfterTake + 1) {
    return best;
  }
  return null;
}

// Jester Ball resolution for a PC holder. Returns 'pass' | 'take' and, for
// 'pass', the chosen new holder's character id. Landing on Boingo mid-
// sequence is no longer a free "return and end it" outcome (confirmed
// ruling, reworked alongside the pass-cap raise below) - it's now just a
// small +1 checkpoint heal for him, and the ball keeps going. Only the
// FINAL pass (reaching MAX_JESTER_BALL_PASSES) decides the big outcome:
// +4 to Boingo, or an explosion on whoever else it lands on. Bots don't
// need special awareness of exactly which pass is the last one - that's
// handled entirely server-side once passCount reaches the cap, regardless
// of what any individual bot "intended" when passing.
const MAX_JESTER_BALL_PASSES = 10;

export function chooseBotJesterBallMove(character, game) {
  const jb = game.jesterBall;
  const boingo = game.characters[jb.thrownByCharacterId];
  const canPass = jb.passCount < MAX_JESTER_BALL_PASSES;
  // Zerathys-specific: deliberately Take the ball to set up an immediate
  // Soul Swap combo (see zerathysBallComboTarget) - this is a bigger tempo
  // swing than relocating the ball via Pass, so it takes priority whenever
  // available. The actual Soul Swap itself isn't chosen here (Take doesn't
  // consume his turn action - he still gets his normal action right after,
  // where chooseZerathysMove's existing Soul Swap logic picks up the same
  // now-even-more-favorable target on its own).
  if (zerathysBallComboTarget(character, game)) {
    return { choice: 'take' };
  }
  // Passing it onto an enemy is the best outcome when available - it moves
  // the eventual -4 (or the whole decision) onto whoever's the biggest
  // threat instead of eating it themselves. Takes priority over passing to
  // Boingo (see below) - a mid-sequence pass to Boingo is now only worth a
  // small +1 checkpoint heal to him (not the old free +4-and-done), so
  // advancing the ball toward a real enemy target clearly beats it
  // whenever one's available.
  if (canPass) {
    const candidates = livingEnemies(game, character).filter((c) => c.id !== character.id);
    if (candidates.length > 0) {
      const targetId = biggestThreatTarget(game, character, candidates.map((c) => c.id))
        || lowestHeartsTarget(game, candidates.map((c) => c.id));
      if (targetId) return { choice: 'pass', targetId };
    }
  }
  // No enemy candidate available (e.g. everyone else is KO'd or a
  // teammate) - passing to Boingo mid-sequence is still free for the
  // holder (no self-damage either way) and either grants him a small +1
  // checkpoint heal (ally/self) or, if he's an enemy, denies the holder
  // nothing extra by doing it anyway since Take costs -4 regardless. Only
  // meaningfully bad when Boingo's an enemy AND the holder could otherwise
  // survive a Take comfortably - handled by the low-hearts fallback below
  // instead of a flat exclusion, matching the previous reasoning's spirit
  // now that the stakes of passing to him are much lower than before.
  if (canPass && boingo && !boingo.isKO && boingo.ownerId === character.ownerId) {
    return { choice: 'pass', targetId: boingo.id };
  }
  if (canPass && boingo && !boingo.isKO && character.hearts <= 4) {
    return { choice: 'pass', targetId: boingo.id };
  }
  // Otherwise Take is the only sensible remaining option.
  return { choice: 'take' };
}

// Boingo's own decision when the ball lands on HIM specifically - he's now
// a genuine holder like anyone else rather than an automatic end-of-line
// (confirmed ruling), with an exclusive third option (Keep) nobody else
// gets. Prioritizes Keep whenever it's genuinely free value: it doesn't
// consume his turn (he still gets his normal Chaos Gamble/etc. that same
// turn) and doesn't burn one of the 10 passes, so there's no real cost to
// sitting on it for a turn UNLESS the match could plausibly end (someone's
// close to a kill and stalling risks never cashing in the eventual +4) -
// keeping this simple rather than trying to model that, since Keep is
// still available again next turn if this one doesn't pan out.
export function chooseBotBoingoJesterBallMove(character, game) {
  const jb = game.jesterBall;
  const canPass = jb.passCount < MAX_JESTER_BALL_PASSES;
  // Take is NEVER a sensible choice for Boingo - it explodes his own ball
  // on himself for a flat -4 with no benefit (see resolveExplosion's
  // sourceCharacterId/targetCharacterId both resolving to him; confirmed
  // live report - the UI shouldn't even offer him this button, and the
  // bot must never choose it either). In practice canPass should always be
  // true here anyway - reaching the pass cap auto-resolves entirely inside
  // pass.execute() itself (boingo.js), tearing down game.jesterBall before
  // this function would ever be asked to decide again - but Keep as a
  // defensive fallback instead of Take either way, never self-harm.
  if (!canPass) {
    return { choice: 'keep' };
  }
  // Deliberately keep it more often than not while healthy - it's free
  // tempo/board presence (an opponent still has to deal with a live ball
  // hanging over the match) and racks up nothing lost, but don't loop on
  // it forever: once he's already comfortably healthy (above half hearts)
  // and the ball has already paid out a few checkpoint heals this
  // sequence, passing it back out keeps the game moving rather than
  // stalling turn after turn for no further benefit. A simple 50/50 avoids
  // needing to track "how many times has it visited him this chain"
  // explicitly.
  if (character.hearts > character.maxHearts / 2 && Math.random() < 0.5) {
    return { choice: 'keep' };
  }
  // Otherwise pass it on toward the biggest remaining enemy threat, same
  // targeting logic every other holder uses.
  const candidates = livingEnemies(game, character).filter((c) => c.id !== character.id);
  if (candidates.length > 0) {
    const targetId = biggestThreatTarget(game, character, candidates.map((c) => c.id))
      || lowestHeartsTarget(game, candidates.map((c) => c.id));
    if (targetId) return { choice: 'pass', targetId };
  }
  // No enemy left to target - just keep holding it rather than passing to
  // a teammate for no benefit (mirrors chooseBotJesterBallMove's own
  // no-candidate fallback, but Keep instead of a teammate-Boingo pass
  // since there's no teammate-Boingo case when Boingo himself is holding).
  return { choice: 'keep' };
}
