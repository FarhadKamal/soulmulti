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
const ROOM_SHAPES = {
  '2p': { seatCount: 2, picksPerSeat: 2 },
  '4p': { seatCount: 4, picksPerSeat: 1 },
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
    playerId: null, // ws-session id, only for kind === 'human'
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

export function findRoomBySessionId(sessionId) {
  for (const room of rooms.values()) {
    if (room.seats.some((s) => s.playerId === sessionId)) return room;
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

export const TURN_TIMER_DURATION_MS = TURN_TIMER_MS;
