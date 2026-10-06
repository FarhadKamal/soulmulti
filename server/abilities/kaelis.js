import { applyDamage, applyHeal, heartsSnapshot } from '../engine/damagePipeline.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';
import { registerOnOwnDeath } from '../engine/categories/onOwnDeath.js';
import { isCurrentFriend } from './melyssa.js';

// Grudge accumulation (see engine/categories/onHitLanded.js): whenever a
// REAL (non-mirrored) hit lands on her, that attacker's per-attacker hit
// COUNT increments by 1 - a stacking counter, not a boolean flag, so 5 hits
// before she retaliates means her next Grudge Strike against that attacker
// deals 5 damage (see grudgeStrike below). Reset to 0 only when SHE later
// lands a Grudge Strike against that same attacker, or when that attacker
// revives (see this file's own onOtherRevived registration above).
// isPoisonTick excluded: Poison Cloud is a single cast ("one attack") that
// then deals passive recurring damage on the victim's own turns with no
// further action from the caster - only the initial cast should register
// as a grudge-worthy attack, not every tick afterward (confirmed bug fix -
// a Kaelis poisoned by Rowan was previously racking up a fresh grudge
// point on every single tick).
registerOnHitLanded('kaelis', (character, game, log, ctx) => {
  if (ctx.isMirror || ctx.isPoisonTick || ctx.amountDealt <= 0 || ctx.sourceCharacterId === 'kaelis') return;
  const counts = character.special.grudgeCounts;
  counts.set(ctx.sourceCharacterId, (counts.get(ctx.sourceCharacterId) || 0) + 1);
});

// Revival cleanup (see engine/categories/onOtherRevived.js) - her grudge
// COUNT against a now-revived character doesn't carry over; they come back
// "fresh," same reasoning as every other stale-reference cleanup. Deleting
// the map key is equivalent to resetting the count to 0
// (grudgeCounts.get() falls back to 0 for an absent key).
registerOnOtherRevived((revivedCharacterId, game) => {
  const kaelis = game.characters.kaelis;
  if (kaelis) kaelis.special.grudgeCounts.delete(revivedCharacterId);
});

const ASHKAS_VENGEANCE_HEARTS_THRESHOLD = 3;
const ASHKAS_VENGEANCE_DAMAGE = 1;
const WINGS_OF_ASHKA_HEARTS_THRESHOLD = 3;
const PHOENIX_DIVE_MIN_DAMAGE = 3; // raised from 2, confirmed ruling 2026-10-06

// Phoenix Dive's damage (confirmed ruling, 2026-10-05): every grudge count
// she currently holds against a LIVING character, added up, never less
// than 2. Exported for the bot's own kill check.
export function phoenixDiveDamage(character, game) {
  let total = 0;
  for (const [attackerId, count] of character.special.grudgeCounts) {
    if (game.characters[attackerId] && !game.characters[attackerId].isKO) total += count;
  }
  return Math.max(PHOENIX_DIVE_MIN_DAMAGE, total);
}

// If she's KO'd mid-flight (only reachable via something that ignores
// untargetable - Earthshatter, Prophecy of Doom, a curse mirror...), she
// simply falls - clear the airborne state so nothing stale lingers.
registerOnOwnDeath('kaelis', (character) => {
  character.special.airborne = false;
  character.untargetable = false;
});

// Bird heal ticks fire on Kaelis's own onTurnStart, unconditionally - this
// runs BEFORE any freeze/skip check (turnEngine.js's beginCharacterTurn
// calls onTurnStart before consumeSkipIfFrozen), so the heal still lands
// even on a turn where she ends up frozen/skipped. Cast turn (callAshka's
// own execute, below) heals immediately and sets ashkaHealsRemaining = 2 -
// this hook only covers the 2 FOLLOW-UP heals, which do not consume her
// turn (she still acts/skips normally alongside the heal).
export function onTurnStart(character, game, log) {
  if (character.special.ashkaHealsRemaining > 0) {
    const healed = applyHeal(game, character.id, 2);
    character.special.ashkaHealsRemaining -= 1;
    // airborne: stamped at the moment of the tick (confirmed ruling,
    // 2026-10-06: the heal continues during Wings of Ashka, but its flash
    // flash is skipped while she's merged with Ashka in the sky; sound and
    // voice still play).
    // Marked on the entry itself rather than read from live state, since a
    // single broadcast can also contain her Phoenix Dive landing her.
    log.push({ type: 'ashka-heal', characterId: character.id, healed, airborne: !!character.special.airborne, hearts: heartsSnapshot(game) });
  }
  // Ashka's Vengeance (hearts<=3 passive, see project memory
  // soulclash_kaelis_ashkas_vengeance.md) - a fully automatic bonus effect,
  // no button/cast, no target choice. Activates permanently the instant her
  // hearts first drop to <=3 (confirmed ruling: "this will continue until
  // her death" / "stays active permanently once triggered" - does NOT
  // clear if she later heals back above 3). Fires every one of her own
  // turns from that point on, layered ON TOP of her normal action that
  // turn (confirmed ruling: "she don't have to hit anything. she will do
  // just her normal attack" - the bonus strike is pure addition, no
  // opportunity cost). Deliberately fires here in onTurnStart - runs even
  // on a turn she ends up frozen/skipped, same reasoning as the bird-heal
  // tick above (both are true passives, unaffected by her own turn being
  // interrupted).
  const wasAlreadyActive = character.special.ashkasVengeanceActive;
  if (!wasAlreadyActive && character.hearts <= ASHKAS_VENGEANCE_HEARTS_THRESHOLD) {
    character.special.ashkasVengeanceActive = true;
    log.push({ type: 'ashkas-vengeance-activate', characterId: character.id, hearts: heartsSnapshot(game) });
  }
  // Confirmed ruling, 2026-10-05: "during merge form ashka should not attack
  // enemy" - while Kaelis is airborne (Wings of Ashka), Ashka is carrying
  // her, so the passive's bonus strike is skipped for those turns. The
  // passive itself stays active and resumes once she lands.
  if (character.special.ashkasVengeanceActive && !character.special.airborne) {
    // Melyssa's Friendship (Redirect Bond #39) - confirmed real bug,
    // 2026-09-22 (live report: "if melyssa becom friend with kaelis. ashka
    // will not attack melyssa also, during friendship"). Ashka's random
    // target pool never went through isValidTarget/isValidPuppetTarget at
    // all (it's a fully automatic passive, not a player-chosen attack), so
    // the mutual no-attack rule those enforce (turnEngine.js's own
    // isCurrentFriend checks) never applied here - Ashka could randomly
    // strike Melyssa directly even while she and Kaelis are bonded. Unlike
    // a normal attack aimed AT Melyssa (which redirects to her friend via
    // damagePipeline.js's own hook), this case is different: Kaelis HERSELF
    // is the friend, and the redirect hook already correctly skips
    // redirecting a hit back onto its own source (friendId === sourceId
    // would be a self-redirect, nonsensical) - so without this exclusion
    // the hit would have landed on Melyssa directly instead of being
    // properly blocked by the bond. Simplest fix: exclude Melyssa from
    // Ashka's own random pool entirely whenever Kaelis is currently her
    // friend, same "flat exclusion, not a redirect" shape already used for
    // Shadow Seal/Moonlit Theft's own Melyssa-as-friend gaps.
    // Blade's Shark Hunt (taxonomy #41, Mutual Seal) - a sealed character
    // is excluded from this automatic random pick too, confirmed ruling:
    // "any mechanism that involves selecting a target - whether player-
    // chosen or automatic/random - cannot reach a sealed pair."
    const others = Object.values(game.characters).filter(
      (c) => c.id !== 'kaelis' && !c.isKO && !(c.id === 'melyssa' && isCurrentFriend(game, 'kaelis')) && !c.deepSeaSealed
    );
    if (others.length > 0) {
      const target = others[Math.floor(Math.random() * others.length)];
      // True Pure Attack (confirmed ruling: "bypasses shield too") -
      // ignoresShield/ignoresDodge/ignoresUntargetable all true, same
      // damage-type rules as Akyros's Shadow Execution. Random selection
      // itself already ignores untargetable (Object.values above doesn't
      // filter on it), matching the confirmed ruling that untargetable
      // status shouldn't stop this at all.
      const result = applyDamage(game, log, {
        sourceCharacterId: 'kaelis',
        targetCharacterId: target.id,
        amount: ASHKAS_VENGEANCE_DAMAGE,
        ignoresShield: true,
        ignoresDodge: true,
        ignoresUntargetable: true,
        // Confirmed ruling, 2026-09-07: "kaleis will not suffer what ashka
        // did" - found via a live match log where Ashka's strike on a
        // Mirror-Reflect-armed Rowan bounced 3 damage back onto Kaelis
        // (5->2 hearts) with no log entry announcing it at all (a second,
        // separate bug - see the deferred-field handling added below).
        // This flag stops Mirror Reflect/curse-mirror from ever triggering
        // off this specific attack in the first place, so there's nothing
        // left to defer for those two mechanics - Ashka acts independently
        // of Kaelis, and nothing that happens to her companion's strike
        // should be attributed back to her.
        isAshkaStrike: true,
      });
      log.push({
        type: 'ashkas-vengeance-strike', characterId: character.id, targetId: target.id,
        amountDealt: result.amountDealt, koTriggered: result.koTriggered, hearts: heartsSnapshot(game),
      });
      // Full deferred-field handling, matching tickPoisonIfAny's own
      // identical standalone-applyDamage-call-site pattern exactly (`log`
      // here is already game.log directly - this whole function runs
      // inside beginCharacterTurn's own real log, not a local batch - so
      // pushing immediately, not deferring further, is correct).
      // rebirthLogEntry: if this 1-damage strike happens to be the killing
      // blow on Blade (at exactly 1 heart) and he hasn't used Rebirth yet,
      // his revival triggers silently without this - confirmed real gap,
      // found via the same audit that caught the Mirror-Reflect issue
      // above.
      if (result.rebirthLogEntry) log.push({ ...result.rebirthLogEntry, hearts: heartsSnapshot(game) });
      // mirrorLogEntry/mirrorReflectLogEntry: should never actually be set
      // now that isAshkaStrike: true stops both Athena's curse-mirror and
      // Rowan's Mirror Reflect from triggering off this attack at all (see
      // above) - kept here defensively anyway, matching every other
      // standalone call site's full field list, in case a future Counter
      // Attack-shaped mechanic is added without remembering this
      // exclusion.
      if (result.mirrorLogEntry) log.push({ ...result.mirrorLogEntry, hearts: heartsSnapshot(game) });
      if (result.mirrorResult?.rebirthLogEntry) log.push({ ...result.mirrorResult.rebirthLogEntry, hearts: heartsSnapshot(game) });
      if (result.mirrorReflectLogEntry) log.push({ ...result.mirrorReflectLogEntry, hearts: heartsSnapshot(game) });
      if (result.mirrorReflectResult?.rebirthLogEntry) log.push({ ...result.mirrorReflectResult.rebirthLogEntry, hearts: heartsSnapshot(game) });
      // Boingo's Fowl Play - if this strike happens to KO him mid-window.
      if (result.fowlPlayRevertLogEntry) log.push({ ...result.fowlPlayRevertLogEntry, hearts: heartsSnapshot(game) });
      // If this 1-damage bonus strike happens to be the killing blow on
      // someone with their OWN Death-Pact-style trigger armed (Athena's
      // Divine Judgment, Oraclus's Prophecy of Doom), those deferred
      // fields need pushing here too.
      if (result.divineJudgmentTriggerLogEntry) log.push({ ...result.divineJudgmentTriggerLogEntry, hearts: heartsSnapshot(game) });
      if (result.prophecyOfDoomTriggerLogEntry) log.push({ ...result.prophecyOfDoomTriggerLogEntry, hearts: heartsSnapshot(game) });
      // Melyssa's Friendship - same reasoning as the two lines above
      // (confirmed real bug, 2026-09-20 - see melyssa.js's own onAnyDeath
      // registration).
      if (result.friendshipEndLogEntry) log.push({ ...result.friendshipEndLogEntry, hearts: heartsSnapshot(game) });
      // Melyssa's Friendship - this strike's own redirect spillover entry
      // (see damagePipeline.js's own comment on friendshipSpilloverLogEntry),
      // same reasoning as friendshipEndLogEntry directly above.
      if (result.friendshipSpilloverLogEntry) log.push({ ...result.friendshipSpilloverLogEntry, hearts: heartsSnapshot(game) });
    }
  }
}

export const actions = {
  grudgeStrike: {
    label: 'Grudge Strike',
    needsTarget: true,
    isLegal: () => true,
    execute(character, targetId, game, log) {
      // A per-attacker hit COUNTER, not a boolean flag - each real hit that
      // attacker landed on her (see damagePipeline.js's applyDamage) adds 1
      // to THEIR OWN count, independent of every other attacker's. Damage
      // here is always the base 1 PLUS that attacker's stored count (e.g.
      // 1 stored hit -> 1+1=2 damage; 0 stored hits -> just the base 1) -
      // the base damage is never replaced, only topped up. Landing a
      // Grudge Strike against ANY target always resets THAT target's count
      // back to 0 afterward (even if it was already 0) - every other
      // attacker's count stays untouched.
      const grudgeCount = character.special.grudgeCounts.get(targetId) || 0;
      const amount = 1 + grudgeCount;
      // Only touch the map when there's a real grudge to clear - confirmed
      // real bug, 2026-10-05: an unconditional set(targetId, 0) changed
      // Kaelis's state even with no grudge, so a fully shield-absorbed hit
      // on Chronox counted as "a real effect" and bot Chronox spent Rewind
      // undoing nothing (twice in one live match). Deleting the key is
      // equivalent to 0 (get() falls back to 0).
      if (grudgeCount > 0) character.special.grudgeCounts.delete(targetId);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grudgeStrike', targetId, wasGrudged: grudgeCount > 0, grudgeCount, ...result });
      return result;
    },
  },
  // Wings of Ashka (design-locked 2026-10-05): hearts<=3 one-time special.
  // Kaelis merges with Ashka and rises into the sky - this cast is her whole
  // turn. While airborne she's untargetable, and on her next REAL turn
  // (a frozen/skipped turn doesn't land her) her only action is Phoenix
  // Dive (see turnEngine.js's getLegalActions override).
  wingsOfAshka: {
    label: 'Wings of Ashka',
    needsTarget: false,
    special: true,
    isLegal: (character) => character.hearts <= WINGS_OF_ASHKA_HEARTS_THRESHOLD
      && !character.special.usedWingsOfAshka && !character.special.airborne,
    execute(character, targetId, game, log) {
      character.special.usedWingsOfAshka = true;
      character.special.airborne = true;
      character.untargetable = true;
      log.push({ type: 'special', characterId: character.id, actionId: 'wingsOfAshka' });
      return {};
    },
  },
  // Phoenix Dive: the crash that ends Wings of Ashka - her ONLY legal action
  // while airborne (hidden: true, surfaced only through turnEngine.js's
  // override, same convention as Grimtal's beastAttack). Confirmed rulings:
  // damage = phoenixDiveDamage (total living grudge, min 3); ignores dodge
  // and untargetable but shield still absorbs; every grudge resets to 0
  // afterward; she lands (no longer untargetable).
  phoenixDive: {
    label: 'Phoenix Dive',
    needsTarget: true,
    hidden: true,
    isLegal: (character) => !!character.special.airborne,
    execute(character, targetId, game, log) {
      const amount = phoenixDiveDamage(character, game);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
        ignoresDodge: true,
        ignoresUntargetable: true,
      });
      character.special.grudgeCounts.clear();
      character.special.airborne = false;
      character.untargetable = false;
      log.push({ type: 'attack', characterId: character.id, actionId: 'phoenixDive', targetId, amount, ...result });
      return result;
    },
  },
  callAshka: {
    label: 'Call Ashka',
    needsTarget: false,
    special: true,
    isLegal: (character) => !character.usedSpecial,
    execute(character, targetId, game, log) {
      character.usedSpecial = true;
      const healed = applyHeal(game, character.id, 2);
      // 2, not 3 - this cast turn's own heal already happened above; this
      // count is only for the 2 FOLLOW-UP turns (see onTurnStart).
      character.special.ashkaHealsRemaining = 2;
      log.push({ type: 'special', characterId: character.id, actionId: 'callAshka', healed });
      return {};
    },
  },
};
