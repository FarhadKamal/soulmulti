// Server-side re-implementation of the turn-sequencing loop that
// dashboardScreen.js drives client-side (see getActingCharacterId /
// explodeBallAsTake / finishJesterBall there). Deliberately strips out every
// bit of rendering/portrait-flash logic - the server only cares about whose
// turn it legally is right now and resolving the actions/effects that must
// happen automatically (frozen skips, the Jester Ball auto-bursting on a
// frozen holder, turn-start passives). Everything else is left to clients to
// render off of the state + log the server broadcasts.
import { CHARACTERS } from './data/characters.js';
import {
  getUsableActions, beginCharacterTurn, consumeSkipIfFrozen, markCharacterActed,
  hasCharacterActedThisTurn, charactersActingThisTurn, resolveJesterBall, endTurn,
} from './engine/turnEngine.js';

// Advances game.log/state past every character who has nothing to legally
// do right now (frozen, no valid targets) and returns the id of the next
// character who actually needs a real decision - or null if the whole
// active player's roster is spent, meaning the caller should call endTurn().
export function getActingCharacterId(game) {
  const acting = charactersActingThisTurn(game);
  for (const character of acting) {
    if (hasCharacterActedThisTurn(game, character.id)) continue;
    const isBallHolder = game.jesterBall && game.jesterBall.holderCharacterId === character.id;
    if (consumeSkipIfFrozen(character)) {
      if (isBallHolder) {
        game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name} is frozen and can't resolve the Jester Ball - it bursts on them!` });
        finishJesterBall(game, 'take', undefined);
      } else {
        game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name} is frozen and skips their turn.` });
      }
      markCharacterActed(game, character.id);
      continue;
    }
    if (!game.turnStartFiredFor.has(character.id)) {
      game.turnStartFiredFor.add(character.id);
      beginCharacterTurn(character, game, game.log);
    }
    if (!isBallHolder && getUsableActions(character, game).length === 0) {
      game.log.push({ type: 'passive', characterId: character.id, text: `${CHARACTERS[character.id].name} has no valid targets and skips their turn.` });
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
