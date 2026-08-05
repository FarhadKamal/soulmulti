import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

import { CHARACTER_IDS } from './data/characters.js';
import { createGame } from './engine/state.js';
import {
  getUsableActions, executeAction, isValidTarget, markCharacterActed,
} from './engine/turnEngine.js';
import { chooseBotMove, chooseBotJesterBallMove, chooseSoulSwapWrathTarget } from './engine/botPlayer.js';
import { settleToNextDecision, finishJesterBall } from './gameFlow.js';
import {
  createRoom, getRoom, deleteRoom, findRoomBySessionId, roomShapeFor,
  availableSeats, availableCharacterIds, seatIsReady, TURN_TIMER_DURATION_MS,
} from './rooms.js';

const PORT = process.env.PORT || 3001;
const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Soul Clash multiplayer server is running.\n');
});
const wss = new WebSocketServer({ server: httpServer });

// sessionId -> ws connection. A session survives a single tab's lifetime -
// there is no reconnect-to-old-session support yet (see multiplayer design
// notes: timeout/leave = permanent bot takeover, so there's nothing to
// reconnect back into anyway).
const sessions = new Map();

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function broadcastRoom(room, type, payload = {}) {
  for (const seat of room.seats) {
    if (seat.kind === 'human' && seat.playerId) {
      const ws = sessions.get(seat.playerId);
      if (ws) send(ws, type, payload);
    }
  }
}

// ---- Lobby snapshot sent to every client whenever room membership/picks change ----
function lobbyView(room) {
  const shape = roomShapeFor(room.roomType);
  return {
    code: room.code,
    roomType: room.roomType,
    picksPerSeat: shape.picksPerSeat,
    ownerId: room.ownerId,
    phase: room.phase,
    seats: room.seats.map((s) => ({
      index: s.index,
      kind: s.kind,
      name: s.name,
      characterIds: s.characterIds,
      isOwner: s.playerId === room.ownerId,
    })),
    availableCharacterIds: availableCharacterIds(room),
  };
}

function broadcastLobby(room) {
  broadcastRoom(room, 'lobby-update', { room: lobbyView(room) });
}

// ---- Game state snapshot. Hidden info (Akyros's unrevealed marks) is
// stripped out here rather than merely hidden client-side - see
// sanitizeGameForBroadcast below - so it never reaches a browser that
// isn't supposed to see it. ----
function sanitizeGameForBroadcast(game) {
  const clone = structuredClone(game);
  for (const character of Object.values(clone.characters)) {
    if (character.id === 'akyros' && character.special?.marks) {
      // marks = hidden, not-yet-revealed marks; only reveal that a mark
      // EXISTS (for Akyros's own owner's UI to show a target reticle) is
      // not done here at all - the server keeps it fully server-side.
      // revealedMarks (post-Shadow Execution) are public and stay as-is.
      character.special.marks = [];
    }
  }
  // Sets don't survive JSON.stringify - convert what's left to arrays.
  for (const character of Object.values(clone.characters)) {
    if (character.special) {
      for (const [k, v] of Object.entries(character.special)) {
        if (v instanceof Set) character.special[k] = [...v];
      }
    }
  }
  return clone;
}

function broadcastGameState(room) {
  const acting = settleToNextDecision(room.game);
  if (room.game.phase === 'game-over') {
    room.phase = 'finished';
    clearTurnTimer(room);
  } else {
    armTurnTimer(room, acting);
  }
  broadcastRoom(room, 'game-state', {
    game: sanitizeGameForBroadcast(room.game),
    actingCharacterId: acting,
  });
}

// ---- Turn timer: 30s per decision. On expiry, treated exactly like the
// player leaving - a bot permanently takes over that seat's remaining moves
// for the rest of the match (see multiplayer design notes). Note: a seat
// can own 2 characters in a 2-player room - timing out bot-takes-over the
// WHOLE seat (both characters), not just the one mid-decision, since the
// same human was going to control both anyway. ----
function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function seatForCharacter(room, characterId) {
  return room.seats.find((s) => s.characterIds.includes(characterId));
}

function armTurnTimer(room, characterId) {
  clearTurnTimer(room);
  if (!characterId) return;
  room.turnTimer = setTimeout(() => {
    const seat = seatForCharacter(room, characterId);
    if (seat && seat.kind === 'human') {
      seat.kind = 'bot';
      seat.playerId = null;
      broadcastLobby(room);
      room.game.log.push({ type: 'passive', characterId, text: 'Turn timed out - a bot takes over.' });
    }
    runBotTurnsIfAny(room);
  }, TURN_TIMER_DURATION_MS);
}

// ---- Bot-driven turns: runs any consecutive bot-controlled characters'
// turns automatically until either a human's decision is needed or the
// match ends. Mirrors the client's scheduleBotMove loop, just without
// render()/timing delays since there's no UI to animate. ----
function isBotControlled(room, characterId) {
  const seat = seatForCharacter(room, characterId);
  return seat?.kind === 'bot';
}

function runBotTurnsIfAny(room) {
  let acting = settleToNextDecision(room.game);
  while (acting && room.game.phase !== 'game-over' && isBotControlled(room, acting)) {
    const character = room.game.characters[acting];
    const isBallHolder = room.game.jesterBall && room.game.jesterBall.holderCharacterId === acting;
    if (isBallHolder) {
      const move = chooseBotJesterBallMove(character, room.game);
      finishJesterBall(room.game, move.choice, move.targetId);
    } else {
      const move = chooseBotMove(character, room.game);
      if (move) {
        executeAction(room.game, acting, move.actionId, move.targetId);
        if (move.actionId === 'soulSwap') {
          const wrathTarget = chooseSoulSwapWrathTarget(character, room.game);
          if (wrathTarget) executeAction(room.game, acting, 'soulSwapWrath', wrathTarget);
        }
      }
      markCharacterActed(room.game, acting);
    }
    acting = settleToNextDecision(room.game);
  }
  broadcastGameState(room);
}

// ---- Room/lobby message handlers ----
function handleCreateRoom(ws, sessionId, { roomType, name }) {
  if (!roomShapeFor(roomType)) {
    return send(ws, 'error', { message: 'Invalid room type.' });
  }
  const room = createRoom(roomType);
  const seat = room.seats[0];
  seat.kind = 'human';
  seat.playerId = sessionId;
  seat.name = name;
  room.ownerId = sessionId;
  send(ws, 'room-created', { code: room.code });
  broadcastLobby(room);
}

function handleJoinRoom(ws, sessionId, { code, name }) {
  const room = getRoom(code);
  if (!room) return send(ws, 'error', { message: 'Room not found.' });
  if (room.phase !== 'lobby') return send(ws, 'error', { message: 'Match already started.' });
  const seat = availableSeats(room)[0];
  if (!seat) return send(ws, 'error', { message: 'Room is full.' });
  seat.kind = 'human';
  seat.playerId = sessionId;
  seat.name = name;
  send(ws, 'room-joined', { code: room.code });
  broadcastLobby(room);
}

function handlePickCharacter(room, sessionId, { characterId }) {
  if (!CHARACTER_IDS.includes(characterId)) return;
  const seat = room.seats.find((s) => s.playerId === sessionId);
  if (!seat) return;
  const shape = roomShapeFor(room.roomType);
  if (seat.characterIds.includes(characterId)) return; // already picked
  if (seat.characterIds.length >= shape.picksPerSeat) return; // seat already full
  if (!availableCharacterIds(room).includes(characterId)) return; // taken elsewhere
  seat.characterIds.push(characterId);
  broadcastLobby(room);
}

function handleUnpickCharacter(room, sessionId, { characterId }) {
  const seat = room.seats.find((s) => s.playerId === sessionId);
  if (!seat) return;
  seat.characterIds = seat.characterIds.filter((id) => id !== characterId);
  broadcastLobby(room);
}

function fillSeatWithBot(room, seat) {
  const shape = roomShapeFor(room.roomType);
  seat.kind = 'bot';
  seat.name = seat.name || 'Bot';
  while (seat.characterIds.length < shape.picksPerSeat) {
    const pool = availableCharacterIds(room);
    if (pool.length === 0) break;
    seat.characterIds.push(pool[Math.floor(Math.random() * pool.length)]);
  }
}

function handleFillBot(room, sessionId, { seatIndex }) {
  if (sessionId !== room.ownerId) return;
  const seat = room.seats[seatIndex];
  if (!seat || seat.kind !== 'empty') return;
  fillSeatWithBot(room, seat);
  broadcastLobby(room);
}

function handleStartMatch(room, sessionId) {
  if (sessionId !== room.ownerId) return;
  // Every human-claimed seat must have finished picking before starting;
  // empty seats are fine (bot-filled below).
  if (room.seats.some((s) => s.kind === 'human' && !seatIsReady(room, s))) return;
  for (const seat of room.seats) {
    if (seat.kind === 'empty') fillSeatWithBot(room, seat);
  }
  const playerPicks = room.seats.map((s) => ({
    id: s.playerId || `bot-${s.index}`,
    name: s.name,
    characterIds: s.characterIds,
    isPC: s.kind === 'bot',
  }));
  room.game = createGame(room.roomType, playerPicks);
  room.phase = 'in-match';
  broadcastLobby(room);
  runBotTurnsIfAny(room);
}

function handleAction(room, sessionId, { characterId, actionId, targetId }) {
  if (room.phase !== 'in-match' || !room.game) return;
  const seat = seatForCharacter(room, characterId);
  if (!seat || seat.playerId !== sessionId) return; // not your character
  const acting = settleToNextDecision(room.game);
  if (acting !== characterId) return; // not this character's decision right now
  const usable = getUsableActions(room.game.characters[characterId], room.game);
  const actionDef = usable.find((a) => a.actionId === actionId);
  if (!actionDef) return;
  if (actionDef.needsTarget && !isValidTarget(room.game, characterId, actionId, targetId)) return;

  executeAction(room.game, characterId, actionId, targetId);

  if (actionId === 'soulSwap') {
    // Soul Swap doesn't mark the character acted yet - the free follow-up
    // Thunder Wrath (soulSwapWrath) still needs a target, same as the
    // client's zerathysSoulSwapFollowUpPending flow. Broadcast the
    // intermediate state (swap already applied) so clients show it, then
    // wait for a soulSwapWrath action message from this same player.
    broadcastRoom(room, 'game-state', { game: sanitizeGameForBroadcast(room.game), actingCharacterId: characterId, awaitingSoulSwapWrath: true });
    return;
  }
  markCharacterActed(room.game, characterId);
  runBotTurnsIfAny(room);
}

function handleSoulSwapWrath(room, sessionId, { characterId, targetId }) {
  if (room.phase !== 'in-match' || !room.game) return;
  const seat = seatForCharacter(room, characterId);
  if (!seat || seat.playerId !== sessionId) return;
  if (!isValidTarget(room.game, characterId, 'soulSwapWrath', targetId)) return;
  executeAction(room.game, characterId, 'soulSwapWrath', targetId);
  markCharacterActed(room.game, characterId);
  runBotTurnsIfAny(room);
}

function handleJesterBallChoice(room, sessionId, { characterId, choice, targetId }) {
  if (room.phase !== 'in-match' || !room.game) return;
  const jb = room.game.jesterBall;
  if (!jb || jb.holderCharacterId !== characterId) return;
  const seat = seatForCharacter(room, characterId);
  if (!seat || seat.playerId !== sessionId) return;
  if (choice === 'pass' && !jb.canPass) return;
  if (choice === 'pass' && !isJesterBallPassTarget(room.game, characterId, targetId)) return;
  finishJesterBall(room.game, choice, targetId);
  runBotTurnsIfAny(room);
}

function isJesterBallPassTarget(game, holderId, targetId) {
  const t = game.characters[targetId];
  if (!t || t.isKO || targetId === holderId) return false;
  return true;
}

// ---- Connection handling ----
wss.on('connection', (ws) => {
  const sessionId = randomUUID();
  sessions.set(sessionId, ws);
  send(ws, 'session', { sessionId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, ...payload } = msg;

    if (type === 'create-room') return handleCreateRoom(ws, sessionId, payload);
    if (type === 'join-room') return handleJoinRoom(ws, sessionId, payload);

    const room = findRoomBySessionId(sessionId);
    if (!room) return;

    switch (type) {
      case 'pick-character': return handlePickCharacter(room, sessionId, payload);
      case 'unpick-character': return handleUnpickCharacter(room, sessionId, payload);
      case 'fill-bot': return handleFillBot(room, sessionId, payload);
      case 'start-match': return handleStartMatch(room, sessionId);
      case 'action': return handleAction(room, sessionId, payload);
      case 'soul-swap-wrath': return handleSoulSwapWrath(room, sessionId, payload);
      case 'jester-ball-choice': return handleJesterBallChoice(room, sessionId, payload);
      default: return;
    }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
    const room = findRoomBySessionId(sessionId);
    if (!room) return;
    const seat = room.seats.find((s) => s.playerId === sessionId);
    if (!seat) return;

    if (room.phase === 'lobby') {
      // Nothing committed yet - just free the seat.
      seat.kind = 'empty';
      seat.playerId = null;
      seat.name = null;
      seat.characterIds = [];
      if (room.ownerId === sessionId) {
        const nextHuman = room.seats.find((s) => s.kind === 'human');
        room.ownerId = nextHuman ? nextHuman.playerId : null;
        if (!room.ownerId) return deleteRoom(room.code);
      }
      broadcastLobby(room);
      return;
    }

    // Mid-match: leaving = permanent bot takeover (same as a timed-out turn).
    seat.kind = 'bot';
    seat.playerId = null;
    if (room.ownerId === sessionId) {
      const nextHuman = room.seats.find((s) => s.kind === 'human');
      room.ownerId = nextHuman ? nextHuman.playerId : null;
    }
    const anyHumanLeft = room.seats.some((s) => s.kind === 'human');
    if (!anyHumanLeft) {
      clearTurnTimer(room);
      deleteRoom(room.code);
      return;
    }
    broadcastLobby(room);
    runBotTurnsIfAny(room);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Soul Clash multiplayer server listening on port ${PORT}`);
});
