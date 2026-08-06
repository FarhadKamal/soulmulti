import { CHARACTER_IDS } from './data/characters.js';

// All rooms live in memory only - no database. A server restart drops every
// in-progress room/match, which is an accepted tradeoff for a free-tier,
// no-persistence hobby deployment (see multiplayer design discussion).
const rooms = new Map(); // code -> room

const TURN_TIMER_MS = 30_000;

// Room type shapes, matching the existing static game's local modes:
// - '2p'  ("2 player" / "2v2"): 2 seats, each seat picks 2 characters as
//   their own personal team - matches the local game's "2 Players" mode.
//   It's called 2v2 because each SIDE fields 2 characters, not because 2
//   separate humans share one side.
// - '4p'  ("4 player" FFA): 4 seats, each seat picks 1 character.
// - 'tutorial': 1 human seat vs 1 scripted bot seat, 1 character each - see
//   server/data/tutorialSequences.js for the scripted move sequence.
const ROOM_SHAPES = {
  '2p': { seatCount: 2, picksPerSeat: 2 },
  '4p': { seatCount: 4, picksPerSeat: 1 },
  tutorial: { seatCount: 2, picksPerSeat: 1 },
};

export function roomShapeFor(roomType) {
  return ROOM_SHAPES[roomType];
}

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

// A "seat" represents one team slot in the eventual match (1 character in
// 4p, 2 characters in 2p). Until the match starts, a seat is either an
// empty slot, a joined human (characters not fully picked yet), or a bot
// (auto-fills every remaining pick, chooses its own characters at start).
function createSeat(index) {
  return {
    index,
    kind: 'empty', // 'empty' | 'human' | 'bot'
    playerId: null, // ws-session id, only for kind === 'human' - who's currently IN CONTROL
    // Once a human ever occupies this seat, their session id is remembered
    // here permanently (even after a timeout/leave hands control to a bot)
    // purely so broadcasts keep reaching their tab - they should still be
    // able to watch the match live as a spectator, just not act anymore.
    // Unlike playerId, this is never cleared back to null.
    spectatorId: null,
    name: null,
    characterIds: [], // length grows up to picksPerSeat as picks are made
  };
}

export function createRoom(roomType) {
  const shape = ROOM_SHAPES[roomType];
  const code = generateRoomCode();
  const seats = Array.from({ length: shape.seatCount }, (_, i) => createSeat(i));

  const room = {
    code,
    roomType, // '2p' | '4p'
    seats,
    ownerId: null, // set once the owner's seat claim happens
    phase: 'lobby', // 'lobby' | 'in-match' | 'finished'
    game: null, // populated by engine createGame() once match starts
    turnTimer: null,
    botSequenceActive: false, // guards against overlapping paced bot-turn sequences
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(code);
}

export function deleteRoom(code) {
  const room = rooms.get(code);
  if (room?.turnTimer) clearTimeout(room.turnTimer);
  rooms.delete(code);
}

// Used to route every incoming message from a session to its room -
// spectatorId, not playerId, since a timed-out/bot-taken-over player
// should still be able to send chat messages (and simply have their
// actual game actions rejected by the per-handler playerId===sessionId
// checks, same as anyone trying to act on a seat that isn't theirs).
export function findRoomBySessionId(sessionId) {
  for (const room of rooms.values()) {
    if (room.seats.some((s) => s.spectatorId === sessionId)) return room;
  }
  return null;
}

export function availableSeats(room) {
  return room.seats.filter((s) => s.kind === 'empty');
}

export function takenCharacterIds(room) {
  return room.seats.flatMap((s) => s.characterIds);
}

export function availableCharacterIds(room) {
  const taken = new Set(takenCharacterIds(room));
  return CHARACTER_IDS.filter((id) => !taken.has(id));
}

// A seat is "ready" once it has picked every character slot it owns (or is
// a bot, which always fills instantly at match start).
export function seatIsReady(room, seat) {
  const shape = ROOM_SHAPES[room.roomType];
  if (seat.kind === 'bot') return true;
  if (seat.kind === 'empty') return false;
  return seat.characterIds.length === shape.picksPerSeat;
}

// Sends everyone back to this same room's lobby after a match ends, so
// players don't have to re-share the room code to play again together.
// Human seats/names are kept as they were, just with picks cleared so they
// choose again. Bot seats are reverted all the way to 'empty' rather than
// staying 'bot' with cleared picks - handleStartMatch only ever re-fills
// seats whose kind is 'empty' (see fillSeatWithBot's call site), so a
// left-as-'bot' seat with no characters would sit there with an empty
// characterIds array forever. That's not just a display bug: the engine
// creates one "player" per seat regardless of character count, and a
// player with zero characters is vacuously "never eliminated"
// ([].every(...) === true in JS) while also never getting an actual turn -
// settleToNextDecision's turn-advance loop can then spin forever trying to
// find a real decision that never comes, which is exactly what happened
// (confirmed via a reproduction: createGame with one empty-roster player
// hangs and OOMs). Reverting to 'empty' guarantees every seat either has a
// real human re-picking or gets properly re-rolled by fillSeatWithBot.
export function resetRoomToLobby(room) {
  room.phase = 'lobby';
  room.game = null;
  // A paced bot-turn sequence (see stepBotTurn in index.js) may still have
  // a setTimeout pending for this room when this reset happens (Exit Game
  // mid-match) - its own !room.game guard prevents it from crashing, but
  // clear the flag here too so a legitimate runBotTurnsIfAny call for the
  // NEXT match started in this room isn't blocked by a stale true left
  // over from the abandoned one.
  room.botSequenceActive = false;
  for (const seat of room.seats) {
    seat.characterIds = [];
    if (seat.kind === 'bot') {
      seat.kind = 'empty';
      seat.name = null;
      seat.spectatorId = null;
    }
  }
}

export const TURN_TIMER_DURATION_MS = TURN_TIMER_MS;
