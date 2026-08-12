// Single reusable damage/heal/shield resolution path.
// Every ability routes its damage through applyDamage() so that shield
// absorption, Akyros's Dodge, Blade's Rebirth, and Athena's curse mirror
// are all handled in one place instead of duplicated per character.

export function applyDamage(game, log, {
  sourceCharacterId,
  targetCharacterId,
  amount,
  ignoresShield = false,
  ignoresUntargetable = false,
  isMirror = false,
}) {
  const target = game.characters[targetCharacterId];
  const result = {
    targetCharacterId,
    amountDealt: 0,
    absorbed: 0,
    dodged: false,
    revived: false,
    koTriggered: false,
    mirrorResult: null,
  };

  if (!target || target.isKO) return result;

  // Untargetable is enforced primarily at the targeting UI layer; this is a
  // defensive re-check so a bug upstream can't sneak damage through.
  if (target.untargetable && !ignoresUntargetable) {
    return result;
  }

  let amt = amount;

  // Akyros Dodge: only applies to direct attacks, never to mirrored damage
  // (confirmed ruling: Athena's curse mirror bypasses Dodge).
  if (target.id === 'akyros' && !isMirror) {
    if (!target.special.dodgedAttackerIds.has(sourceCharacterId)) {
      target.special.dodgedAttackerIds.add(sourceCharacterId);
      result.dodged = true;
      log.push({ type: 'dodge', attackerId: sourceCharacterId, targetCharacterId });
      return result;
    }
  }

  if (!ignoresShield && target.shield > 0) {
    const absorbed = Math.min(target.shield, amt);
    target.shield -= absorbed;
    amt -= absorbed;
    result.absorbed = absorbed;
  }

  target.hearts = Math.max(0, target.hearts - amt);
  result.amountDealt = amt;

  // Blade Rebirth: automatic, intercepts the KO the instant it would happen.
  if (target.id === 'blade' && target.hearts === 0 && !target.special.rebirthUsed) {
    target.hearts = 2;
    target.special.rebirthUsed = true;
    target.usedSpecial = true;
    result.revived = true;
    // Comes back fresh: clear any lingering negative status rather than
    // carrying it over from the moment he died.
    target.skipNextTurn = false;
    target.special.streakTargetId = null;
    target.special.streakCount = 0;
    const athena = Object.values(game.characters).find(
      (c) => c.id === 'athena' && c.special.curseTargetCharacterId === target.id
    );
    if (athena) athena.special.curseTargetCharacterId = null;
    // Chronox's Time Freeze doesn't just set skipNextTurn once - it's
    // re-applied on CHRONOX's own next turn via freezeActive/freezeTargetId
    // (see chronox.js onTurnStart), which has no awareness that its target
    // died and came back in between. Clearing skipNextTurn above alone
    // isn't enough - Chronox would just re-freeze the reborn Blade on his
    // next turn since he's still tracked as the frozen target. Ending the
    // freeze here too matches "comes back fresh with no negative energy."
    const chronox = Object.values(game.characters).find(
      (c) => c.id === 'chronox' && c.special.freezeActive && c.special.freezeTargetId === target.id
    );
    if (chronox) {
      chronox.special.freezeActive = false;
      chronox.special.freezeTargetId = null;
    }
    // Akyros's current Hidden Mark on Blade doesn't survive his death
    // either - he's coming back fresh, so Fatal Slash/Shadow Execution
    // shouldn't still get the marked bonus against him. Only the CURRENT
    // mark is cleared (marks/revealedMarks) - everMarkedIds is left alone,
    // so Akyros still can't place a brand-new mark on him later (same
    // "once marked, never again" rule as everyone else).
    const akyros = Object.values(game.characters).find((c) => c.id === 'akyros');
    if (akyros) {
      akyros.special.marks.delete(target.id);
      akyros.special.revealedMarks.delete(target.id);
    }
    // Deferred (not pushed to `log` here) and returned on the result so
    // executeAction() can push it AFTER the triggering attack's own log
    // entry - otherwise it lands BEFORE that entry in the log, since this
    // runs mid-way through the ability's execute(), before its own
    // log.push() for the attack/special line itself.
    result.rebirthLogEntry = { type: 'rebirth', targetCharacterId };
  } else if (target.hearts === 0) {
    target.isKO = true;
    result.koTriggered = true;
    // Akyros's marks (hidden and revealed) die with him - no point keeping
    // track of them once he can never use Fatal Slash/Shadow Execution again.
    if (target.id === 'akyros') {
      target.special.marks.clear();
      target.special.revealedMarks.clear();
    }
    // Chronox's Time Freeze ends immediately if he's KO'd - no one left to
    // keep re-applying the skip each round, so the frozen target is freed
    // rather than being stuck frozen with no way for it to ever lift.
    if (target.id === 'chronox' && target.special.freezeActive) {
      const frozenId = target.special.freezeTargetId;
      const frozen = game.characters[frozenId];
      if (frozen) frozen.skipNextTurn = false;
      target.special.freezeActive = false;
      target.special.freezeTargetId = null;
      log.push({ type: 'freeze-end', targetCharacterId: frozenId });
    }
  }

  // Melyssa's reactive shield: whenever damage actually reaches her hearts
  // (result.amountDealt, computed above - already reduced by absorption for
  // a normal hit, or the full raw amount for an ignoresShield hit since
  // those skip absorption entirely), she gains new shield EXACTLY equal to
  // that leaked-through amount, REPLACING whatever shield she had left (not
  // additive - see applyShield below, which is +=). Reuses the same
  // decaying:true persistence Tharox/Athena already have (clears only at
  // the start of HER OWN next turn, via decayShieldIfDue in melyssa.js's
  // onTurnStart). Fires even when amountDealt is 0 (a fully-absorbed hit) -
  // REPLACE semantics mean a stale leftover shield must be explicitly
  // zeroed that turn too, not just left alone. Gated on !isKO purely for a
  // clean broadcast snapshot on a dead character (harmless either way,
  // since applyDamage's own early isKO guard blocks any future hit from
  // ever reading it again).
  if (target.id === 'melyssa' && !target.isKO) {
    target.shield = result.amountDealt;
    target.shieldDecaying = true;
  }

  // Athena curse mirror: triggered by damage actually landing on Athena.
  // The mirror log entry is deferred (returned on the result, not pushed to
  // `log` here) and pushed by executeAction() after the triggering ability's
  // own log entries - otherwise it lands in the log BEFORE the attack line
  // that caused it, since applyDamage() runs before the caller's own push.
  if (target.id === 'athena' && !isMirror && result.amountDealt > 0) {
    const cursedId = target.special.curseTargetCharacterId;
    if (cursedId && game.characters[cursedId] && !game.characters[cursedId].isKO) {
      result.mirrorResult = applyDamage(game, log, {
        sourceCharacterId,
        targetCharacterId: cursedId,
        amount: result.amountDealt,
        ignoresShield: false,
        ignoresUntargetable: true,
        isMirror: true,
      });
      result.mirrorLogEntry = {
        type: 'curse-mirror',
        fromCharacterId: 'athena',
        toCharacterId: cursedId,
        amount: result.amountDealt,
        koTriggered: result.mirrorResult.koTriggered,
        revived: result.mirrorResult.revived,
      };
    }
  }

  return result;
}

export function applyHeal(game, targetCharacterId, amount) {
  const target = game.characters[targetCharacterId];
  if (!target || target.isKO) return 0;
  const before = target.hearts;
  target.hearts = Math.min(target.maxHearts, target.hearts + amount);
  return target.hearts - before;
}

export function applyShield(game, targetCharacterId, amount, { decaying = false } = {}) {
  const target = game.characters[targetCharacterId];
  if (!target || target.isKO) return;
  target.shield += amount;
  if (decaying) target.shieldDecaying = true;
}

// Called at the start of a character's own turn: decaying shields (Tharox
// Glory Smash, Athena Divine Restore) expire once that character's next
// turn begins, regardless of how many rounds/other players passed.
export function decayShieldIfDue(character) {
  if (character.shieldDecaying) {
    character.shield = 0;
    character.shieldDecaying = false;
  }
}
