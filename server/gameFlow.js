// Server-side re-implementation of the turn-sequencing loop that
// dashboardScreen.js drives client-side (see getActingCharacterId /
// explodeBallAsTake / finishJesterBall there). Deliberately strips out every
// bit of rendering/portrait-flash logic - the server only cares about whose
// turn it legally is right now and resolving the actions/effects that must
// happen automatically (frozen skips, the Jester Ball auto-bursting on a
// frozen holder, turn-start passives). Everything else is left to clients to
// render off of the state + log the server broadcasts.
import { CHARACTERS } from '../client/js/characters.js';
import {
  getUsableActions, beginCharacterTurn, consumeSkipIfFrozen, consumeSkipIfHeadache, markCharacterActed,
  hasCharacterActedThisTurn, charactersActingThisTurn, resolveJesterBall, endTurn,
  tickChronoxLockoutIfAny,
} from './engine/turnEngine.js';

// Zeroes out a stalled Draxus bonus turn (see draxus.js's onTurnStart) when
// getActingCharacterId itself ends his turn via markCharacterActed below,
// bypassing index.js's normal post-executeAction decrement entirely - e.g.
// he's frozen mid-bonus-turn, or every remaining enemy is KO'd/untargetable
// so he has no legal target left for a strike he still owed. Without this,
// bonusActionsRemaining would leak a stale >0 value into his next real
// turn, wrongly making him look like he still owes strikes from last round.
function clearStalledBonusTurn(character) {
  if (character.id === 'draxus' && character.special.bonusActionsRemaining > 0) {
    character.special.bonusActionsRemaining = 0;
  }
}

// Advances game.log/state past every character who has nothing to legally
// do right now (frozen, no valid targets) and returns the id of the next
// character who actually needs a real decision - or null if the whole
// active player's roster is spent, meaning the caller should call endTurn().
export function getActingCharacterId(game) {
  const acting = charactersActingThisTurn(game);
  for (const character of acting) {
    if (hasCharacterActedThisTurn(game, character.id)) continue;
    const isBallHolder = game.jesterBall && game.jesterBall.holderCharacterId === character.id;
    // Fire this character's OWN turn-start hooks before checking whether
    // they're frozen this round - their turn is genuinely starting even if
    // it then gets skipped, and several onTurnStart-driven effects need
    // that to happen regardless (Rowan's Mirror Reflect window/Arcane
    // Study reveal/poison+silence ticks, Draxus's death-proof window,
    // Chronox's own shield reset). Previously this was gated INSIDE the
    // "not frozen" branch below, so a frozen character's onTurnStart never
    // fired at all that round - confirmed live: Mirror Reflect stayed
    // active indefinitely (never cleared) whenever Rowan's own turn got
    // skipped by a freeze, since the hook that clears it never ran.
    if (!game.turnStartFiredFor.has(character.id)) {
      game.turnStartFiredFor.add(character.id);
      // Monotonically increasing per-character turn counter, deliberately
      // NEVER reset (unlike turnStartFiredFor/actedThisTurn, which reset
      // every round) - recordActionAgainstChronoxIfApplicable
      // (turnEngine.js) uses this to tell "still the same turn's combo,
      // don't overwrite the Rewind record" apart from "a genuinely new
      // turn's first hit, DO overwrite" for the same caster. Neither
      // actedThisTurn (false at the START of every turn, indistinguishable
      // from mid-combo) nor turnStartFiredFor (a per-round Set, not a
      // counter, so it can't tell turn 3 apart from turn 5) can make that
      // distinction on their own.
      game.turnInstanceFor.set(character.id, (game.turnInstanceFor.get(character.id) ?? 0) + 1);
      beginCharacterTurn(character, game, game.log);
    }
    // beginCharacterTurn can itself deal lethal damage (a poison tick, or a
    // curse-mirror chained off one) - `acting` was snapshotted before this
    // ran, so a character who just died here is still in the loop as a
    // stale, pre-death object. Without this check, the loop falls through
    // to consumeSkipIfFrozen/getUsableActions on an already-KO'd character
    // and can return their id as if they still need a decision - confirmed
    // live: the board showed everyone but Rowan as KO, yet the game stayed
    // stuck on "Waiting for Athena's turn" because her own poison tick (or
    // the curse-mirror it triggered) killed her inside this exact call.
    if (character.isKO) {
      clearStalledBonusTurn(character);
      markCharacterActed(game, character.id);
      continue;
    }
    if (consumeSkipIfFrozen(character)) {
      if (isBallHolder) {
        game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name} is frozen and can't resolve the Jester Ball - it bursts on them!` });
        finishJesterBall(game, 'take', undefined);
      } else {
        game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name} is frozen and skips their turn.` });
      }
      clearStalledBonusTurn(character);
      markCharacterActed(game, character.id);
      continue;
    }
    // Grimtal's Skull Crack headache - own dedicated skip source/message,
    // not the freeze branch above (see turnEngine.js's
    // consumeSkipIfHeadache for why this needed its own flag). The
    // 'headache-roll' log entry (pushed from beginCharacterTurn, just
    // above this loop iteration) already announced the flare-up itself;
    // this is the actual turn-skip consequence of that roll.
    if (consumeSkipIfHeadache(character)) {
      if (isBallHolder) {
        game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name}'s headache is too much to resolve the Jester Ball - it bursts on them!` });
        finishJesterBall(game, 'take', undefined);
      } else {
        game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name}'s headache is too much - they skip their turn.` });
      }
      clearStalledBonusTurn(character);
      markCharacterActed(game, character.id);
      continue;
    }
    // Past both skip checks - this character is genuinely getting a turn,
    // so this is the right moment to count it against Chronox's Rewind
    // lockout (see tickChronoxLockoutIfAny's own comment for why this can't
    // live in beginCharacterTurn above).
    //
    // Guarded by chronoxLockoutTickedFor the same way beginCharacterTurn is
    // guarded by turnStartFiredFor above - getActingCharacterId itself is
    // NOT guaranteed to run only once per pending decision (index.js calls
    // settleToNextDecision/getActingCharacterId repeatedly while the SAME
    // character is still un-acted - e.g. once from stepBotTurn to pick a
    // move, then again from a broadcastGameState in the same step, per the
    // documented "settleToNextDecision called again mid-step" pattern).
    // Without this guard, tickChronoxLockoutIfAny (a plain decrement-and-
    // clear with no idempotency of its own) fired twice before the
    // character's action ever resolved - fully clearing a fresh 1-turn
    // lockout before the locked-out caster's turn had actually happened.
    // Confirmed live: Chronox rewound Athena's Divine Sacrifice, and she
    // was able to cast it on him again on what was supposed to be her
    // locked-out very next turn.
    if (!game.chronoxLockoutTickedFor.has(character.id)) {
      game.chronoxLockoutTickedFor.add(character.id);
      tickChronoxLockoutIfAny(character, game, game.log);
    }
    if (!isBallHolder && getUsableActions(character, game).length === 0) {
      game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name} has no valid targets and skips their turn.` });
      clearStalledBonusTurn(character);
      markCharacterActed(game, character.id);
      continue;
    }
    return character.id;
  }
  return null;
}

// Resolves a Jester Ball holder's choice (pass/take) - passing TO Boingo
// (heals him, ends the ball) and an un-intercepted 5th pass (auto-resolves
// as an explosion on the RECEIVER) are both still reached via 'pass', not
// a separate choice. Pass consumes the holder's turn action regardless of
// which of those three outcomes it resolves to, since the PASSER made a
// choice either way; Take does not - the holder still gets their normal
// action afterward in the same turn (matches finishJesterBall in
// dashboardScreen.js).
export function finishJesterBall(game, choice, targetId) {
  const holderId = game.jesterBall.holderCharacterId;
  resolveJesterBall(game, holderId, choice, targetId);
  if (choice !== 'take') {
    markCharacterActed(game, holderId);
  }
}

// Runs getActingCharacterId in a loop, auto-advancing turns (endTurn) when
// nobody on the active roster has anything left to do, until either a real
// decision is needed or the game is over. Call this after every state
// mutation (action executed, ball resolved, turn ended) to settle the game
// back into "waiting on characterId" before broadcasting to clients.
//
// Bounded defensively: a player with an empty characterIds array (should
// never happen via normal play - createGame always assigns at least one
// character per seat - but DID happen for real via a room-management bug
// where a bot seat kept an empty roster across a "return to lobby" reset)
// is vacuously "never eliminated" ([].every(...) === true in JS) while also
// never producing a real decision, so this loop would spin calling endTurn
// forever - confirmed via reproduction, it OOM-crashed the whole server
// process, not just that one room/match. MAX_ITERATIONS is generous (a real
// match settles in well under 1000 endTurn calls) - hitting it means
// something is genuinely stuck, so force the match to a safe end instead of
// taking the process down with it.
const MAX_SETTLE_ITERATIONS = 5000;
export function settleToNextDecision(game) {
  let iterations = 0;
  while (game.phase !== 'game-over') {
    if (++iterations > MAX_SETTLE_ITERATIONS) {
      game.phase = 'game-over';
      game.winnerPlayerId = null;
      game.log.push({ type: 'passive', text: 'Match ended unexpectedly (internal error) - treated as a draw.' });
      return null;
    }
    const characterId = getActingCharacterId(game);
    if (characterId) return characterId;
    endTurn(game);
  }
  return null;
}
