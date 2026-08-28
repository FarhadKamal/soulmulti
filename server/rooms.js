import { CHARACTER_IDS } from '../client/js/characters.js';

// All rooms live in memory only - no database. A server restart drops every
// in-progress room/match, which is an accepted tradeoff for a free-tier,
// no-persistence hobby deployment (see multiplayer design discussion).
const rooms = new Map(); // code -> room

const TURN_TIMER_MS = 30_000;

// Room type shapes, matching the existing static game's local modes:
// - '4p'  ("4 player" FFA): 4 seats, each seat picks 1 character.
// - 'bots4': 4 bot-only seats, no human seat at all - a pure "watch the
//   bots play" spectacle room (see handleCreateBotShowRoom in index.js).
//   Same shape as '4p' since it reuses the same engine mode/turn order.
const ROOM_SHAPES = {
  '4p': { seatCount: 4, picksPerSeat: 1 },
  bots4: { seatCount: 4, picksPerSeat: 1 },
};

// Total room membership cap (4 player seats + Guests, flexibly sharing
// whatever isn't occupied by a real human seat - confirmed ruling: fewer
// seated humans means MORE guest room, not a fixed separate guest quota).
const MAX_ROOM_MEMBERS = 10;

// How long a just-unseated human is barred from claiming ANY seat again in
// this room (confirmed ruling) - applies only to that specific session,
// every other Guest is unaffected. Short enough not to feel punitive, long
// enough that "unseat" can't be trivially undone by the same person
// instantly re-claiming the seat they were just removed from.
const RESEAT_COOLDOWN_MS = 5000;

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

// A "seat" represents one team slot in the eventual match (1 character).
// Until the match starts, a seat is either an
// empty slot, a joined human (characters not fully picked yet), or a bot
// (auto-fills every remaining pick, chooses its own characters at start).
//
// No reconnect-token/grace-period mechanism (confirmed ruling: "nothing
// will save in client side memory... they must join by room number again
// to attend as guest") - a disconnect or explicit leave converts a seat
// straight to a bot, immediately, with no window to reclaim it via a saved
// secret. Getting back into a match is always the same generic path: join
// the room fresh by code (becomes a Guest), then claim any bot-controlled
// seat directly (see index.js's handleClaimSeat, now usable mid-match too,
// not just in the lobby).
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
    roomType, // '4p' | 'bots4'
    seats,
    ownerId: null, // set once the owner's seat claim happens - stays null for a 'bots4' room, which has no human-owned seat
    phase: 'lobby', // 'lobby' | 'in-match' | 'finished'
    game: null, // populated by engine createGame() once match starts
    turnTimer: null,
    botSequenceActive: false, // guards against overlapping paced bot-turn sequences
    createdAt: Date.now(),
    // Session ids watching this room WITHOUT occupying a seat - "Guests."
    // Originally only populated for a 'bots4' room (see
    // handleCreateBotShowRoom), where every seat is a bot and the
    // connecting viewer has nothing to claim; now also the general Guest
    // mechanism for a real '4p' room (join-as-guest, and anyone unseated
    // via handleUnseatPlayer - see index.js). broadcastRoom/
    // broadcastPersonalized (index.js) and findRoomBySessionId (below)
    // both need to know about these sessions too, not just seat.spectatorId.
    spectatorIds: new Set(),
    // Display name for each Guest session (parallel to seat.name for a
    // seated player) - a bare spectatorIds Set alone has nowhere to store
    // this. Never cleared once set for a session still present in
    // spectatorIds; removed when they leave/claim a seat.
    guestNames: new Map(),
    // sessionId -> timestamp (Date.now() + RESEAT_COOLDOWN_MS) until which
    // that specific session may not claim ANY seat in this room - set only
    // by handleUnseatPlayer, checked by handlePickCharacter/whatever claims
    // an empty seat. Entries are self-expiring (checked against Date.now()
    // at claim time, never proactively swept) - a stale past-timestamp
    // entry is harmless dead weight, just never blocks anything once its
    // time has passed.
    reseatCooldowns: new Map(),
    // Only set for a 'bots4' room created via the custom-pick flow (see
    // handleCreateBotShowRoom in index.js) - an ordered array of exactly
    // seatCount character ids the viewer chose, so startFreshBotShowMatch
    // can seat those same characters again on every auto-restart instead
    // of drifting back to a fully random lineup. Left null for the normal
    // "Start Watching" random flow.
    pinnedCharacterIds: null,
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
    if (room.spectatorIds.has(sessionId)) return room;
  }
  return null;
}

// Total distinct people currently in the room - occupied human seats
// (kind === 'human', by playerId, not spectatorId, so a timed-out/bot-
// taken-over seat's lingering spectatorId isn't double-counted alongside
// its own Guest entry once unseated) plus every Guest session.
export function totalRoomMembers(room) {
  const seatedHumans = room.seats.filter((s) => s.kind === 'human').length;
  return seatedHumans + room.spectatorIds.size;
}

export function roomHasCapacity(room) {
  return totalRoomMembers(room) < MAX_ROOM_MEMBERS;
}

// True if sessionId is currently barred from claiming a seat in this room
// (RESEAT_COOLDOWN_MS after being unseated - confirmed ruling, applies
// only to the specific person just removed).
export function isOnReseatCooldown(room, sessionId) {
  const until = room.reseatCooldowns.get(sessionId);
  return !!until && until > Date.now();
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
export const RESEAT_COOLDOWN_DURATION_MS = RESEAT_COOLDOWN_MS;
export const MAX_ROOM_MEMBERS_COUNT = MAX_ROOM_MEMBERS;
