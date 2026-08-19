// Single reusable damage/heal/shield resolution path.
// Every ability routes its damage through applyDamage() so that shield
// absorption, Akyros's Dodge, Blade's Rebirth, and Athena's curse mirror
// are all handled in one place instead of duplicated per character.

// True if ANY character currently has characterId locked under their own
// Silence Lock (Rowan's special.silenceTargets Map) - written generically
// (scans every character's .special rather than assuming Rowan specifically)
// so any future silence-capable character needs no changes here. Lives here
// (not turnEngine.js, which imports it) rather than the reverse, since this
// file has zero imports of its own and turnEngine.js already imports
// applyDamage from here - keeping the dependency one-directional avoids a
// circular import between the two.
export function isSilenced(character, game) {
  return Object.values(game.characters).some(
    (c) => c.special?.silenceTargets?.has(character.id)
  );
}

export function applyDamage(game, log, {
  sourceCharacterId,
  targetCharacterId,
  amount,
  ignoresShield = false,
  ignoresUntargetable = false,
  isMirror = false,
  isPoisonTick = false,
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

  // Set below if this hit KOs a cursed Athena - captures curseTargetCharacterId
  // before the KO branch clears it, so the killing blow can still mirror.
  let preClearCursedId = null;

  // Rowan's Mirror Reflect: any direct (non-mirrored) hit that lands real
  // damage on him while it's active, and that he SURVIVES (target.hearts
  // already reflects the reduction above, so > 0 here means he's still
  // alive), automatically deals 3 damage back to the attacker - on top of
  // Rowan still taking the original hit normally (this doesn't block/
  // reduce anything). Modeled directly on Athena's own curse-mirror below:
  // a nested applyDamage call with isMirror: true, which both prevents
  // Akyros's Dodge from applying to the reflected hit and prevents
  // infinite mirror recursion. The active flag itself is NOT cleared here
  // (stays active for the rest of the window, in case more than one hit
  // lands before Rowan's own next turn clears it via his onTurnStart).
  if (target.id === 'rowan' && target.special.mirrorReflectActive && !isMirror
    && result.amountDealt > 0 && target.hearts > 0 && sourceCharacterId !== 'rowan') {
    result.mirrorReflectResult = applyDamage(game, log, {
      sourceCharacterId: target.id,
      targetCharacterId: sourceCharacterId,
      amount: 3,
      isMirror: true,
    });
    result.mirrorReflectLogEntry = {
      type: 'mirror-reflect',
      fromCharacterId: target.id,
      toCharacterId: sourceCharacterId,
      amount: 3,
      koTriggered: result.mirrorReflectResult.koTriggered,
      revived: result.mirrorReflectResult.revived,
    };
  }

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
    // Kaelis's grudge COUNT against the reviving character doesn't carry
    // over - he/she comes back "fresh," same reasoning as the Akyros
    // mark/Chronox freeze/Athena curse cleanup above. Deleting the map key
    // is equivalent to resetting the count to 0 (grudgeCounts.get() falls
    // back to 0 for an absent key). Looked up generically (not assumed to
    // be Blade specifically) so this also covers any future revive-capable
    // character without needing changes here.
    const kaelis = Object.values(game.characters).find((c) => c.id === 'kaelis');
    if (kaelis) kaelis.special.grudgeCounts.delete(target.id);
    // Rowan's Poison Cloud doesn't survive Rebirth either, same "comes back
    // fresh" reasoning as the grudge-count clear above - otherwise the very
    // next poison tick on his own turn would immediately start killing him
    // again with no way to ever escape it.
    const rowan = Object.values(game.characters).find((c) => c.id === 'rowan');
    if (rowan) rowan.special.poisonTargets.delete(target.id);
    // Deferred (not pushed to `log` here) and returned on the result so
    // executeAction() can push it AFTER the triggering attack's own log
    // entry - otherwise it lands BEFORE that entry in the log, since this
    // runs mid-way through the ability's execute(), before its own
    // log.push() for the attack/special line itself.
    result.rebirthLogEntry = { type: 'rebirth', targetCharacterId };
  } else if (target.id === 'draxus' && target.hearts === 0 && target.special.deathproofActive) {
    // Floors at 1 instead of KO - NOT a revival event (isKO is never set,
    // no "comes back fresh" cleanup like Rebirth's above, since he never
    // actually died: his hearts never truly reach/stay at 0). Deliberately
    // NOT flipped off here, unlike Blade's one-shot rebirthUsed - stays
    // active and re-triggers for every subsequent qualifying hit (any
    // source: direct attacks, curse mirrors, Jester Ball explosions, all
    // of which route through this same applyDamage) until his own
    // onTurnStart clears it (draxus.js), at the start of his own next turn.
    target.hearts = 1;
    result.deathproofSave = true;
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
    // Athena's curse ends the instant she's KO'd - no one left to trigger
    // the mirror going forward (her own isKO guard at the top of this
    // function blocks any FUTURE hit from ever reading it again), but
    // curseTargetCharacterId itself was otherwise never cleared, leaving the
    // client's cursed-mark visual (battleScreen.js) and bot AI's
    // isCursedByLiveAthena-style checks with stale state to read.
    // preClearCursedId below captures the value BEFORE this clear so the
    // mirror-trigger block further down (which runs after this KO branch,
    // in the same applyDamage call) still sees who was cursed - the killing
    // blow itself landed while she was alive and should still mirror, only
    // hits AFTER her death shouldn't. Confirmed bug: without capturing this,
    // the exact hit that killed a cursed Athena silently dropped its own
    // mirror, since curseTargetCharacterId was already null by the time the
    // mirror check ran.
    if (target.id === 'athena' && target.special.curseTargetCharacterId) {
      preClearCursedId = target.special.curseTargetCharacterId;
      target.special.curseTargetCharacterId = null;
    }
    // Rowan's own death ends every effect HE cast on anyone else
    // immediately - Poison Cloud stops ticking, Silence Lock's remaining
    // turns are cleared (targets freed), and a still-pending Mirror
    // Reflect window is cancelled. Does not undo damage already dealt by
    // past ticks/reflects, only stops future ones (confirmed explicit
    // design rule). Effects live on Rowan's own .special (matching every
    // other caster-side effect in the codebase), so this is a direct
    // clear, no cross-character scan needed.
    if (target.id === 'rowan') {
      target.special.poisonTargets.clear();
      target.special.silenceTargets.clear();
      target.special.mirrorReflectActive = false;
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
    // Rowan's Silence Lock suppresses every shield source while active
    // (see isSilenced above) - including this reactive one, so a silenced
    // Melyssa gets 0 here instead of the normal leaked-damage amount.
    target.shield = isSilenced(target, game) ? 0 : result.amountDealt;
    target.shieldDecaying = true;
  }

  // Kaelis's grudge: whenever a REAL (non-mirrored) hit lands on her, that
  // attacker's per-attacker hit COUNT increments by 1 - a stacking counter,
  // not a boolean flag, so 5 hits before she retaliates means her next
  // Grudge Strike against that attacker deals 5 damage (see kaelis.js).
  // Reset to 0 only when SHE later lands a Grudge Strike against that same
  // attacker, or when that attacker revives (see the Rebirth block above).
  // Gated identically to Athena's own curse-trigger check just below
  // (!isMirror && result.amountDealt > 0) - a fully shield-absorbed or
  // mirrored hit does not count as "attacking her" for this purpose.
  // isPoisonTick is also excluded: Poison Cloud is a single cast ("one
  // attack") that then deals passive recurring damage on the victim's own
  // turns with no further action from Rowan - only the initial cast should
  // register as a grudge-worthy attack, not every tick afterward. Confirmed
  // bug report: a Kaelis poisoned by Rowan was racking up a fresh grudge
  // point on every single tick, turning one cast into an ever-growing
  // Grudge Strike far beyond what "one hit" should earn.
  if (target.id === 'kaelis' && !isMirror && !isPoisonTick && result.amountDealt > 0 && sourceCharacterId !== 'kaelis') {
    const counts = target.special.grudgeCounts;
    counts.set(sourceCharacterId, (counts.get(sourceCharacterId) || 0) + 1);
  }

  // Athena curse mirror: triggered by damage actually landing on Athena.
  // The mirror log entry is deferred (returned on the result, not pushed to
  // `log` here) and pushed by executeAction() after the triggering ability's
  // own log entries - otherwise it lands in the log BEFORE the attack line
  // that caused it, since applyDamage() runs before the caller's own push.
  if (target.id === 'athena' && !isMirror && result.amountDealt > 0) {
    const cursedId = target.special.curseTargetCharacterId ?? preClearCursedId;
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
  // Rowan's Silence Lock blocks every shield source while active, not just
  // his special-ability lock - a silenced Athena/Tharox still casts Divine
  // Restore/Glory Smash normally (those aren't blocked by isLegal), but the
  // shield portion of it simply does nothing while silenced.
  if (isSilenced(target, game)) return;
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
