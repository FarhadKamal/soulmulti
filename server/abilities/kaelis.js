import { applyDamage, applyHeal, heartsSnapshot } from '../engine/damagePipeline.js';
import { registerOnOtherRevived } from '../engine/categories/onOtherRevived.js';
import { registerOnHitLanded } from '../engine/categories/onHitLanded.js';

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
    log.push({ type: 'ashka-heal', characterId: character.id, healed, hearts: heartsSnapshot(game) });
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
  if (character.special.ashkasVengeanceActive) {
    const others = Object.values(game.characters).filter((c) => c.id !== 'kaelis' && !c.isKO);
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
      character.special.grudgeCounts.set(targetId, 0);
      const result = applyDamage(game, log, {
        sourceCharacterId: character.id,
        targetCharacterId: targetId,
        amount,
      });
      log.push({ type: 'attack', characterId: character.id, actionId: 'grudgeStrike', targetId, wasGrudged: grudgeCount > 0, grudgeCount, ...result });
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
