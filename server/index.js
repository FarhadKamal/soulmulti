import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

import { CHARACTER_IDS } from './data/characters.js';
import { createGame } from './engine/state.js';
import {
  getUsableActions, executeAction, isValidTarget, markCharacterActed,
} from './engine/turnEngine.js';
import { chooseBotMove, chooseBotJesterBallMove, chooseSoulSwapWrathTarget } from './engine/botPlayer.js';
import { settleToNextDecision, finishJesterBall } from './gameFlow.js';
import {
  createRoom, getRoom, deleteRoom, findRoomBySessionId, roomShapeFor,
  availableSeats, availableCharacterIds, seatIsReady, resetRoomToLobby, TURN_TIMER_DURATION_MS,
} from './rooms.js';

const PORT = process.env.PORT || 3001;

// Serves the client's static files (HTML/CSS/JS/assets) from the SAME
// origin/port as the WebSocket server, rather than requiring a separate
// static file server (dev_server.py, used only for local dev) - this is
// what actually lets net.js's resolveServerUrl() connect same-origin in
// production instead of needing a second port punched through
// port-forwarding/a reverse proxy. ../client resolves relative to this
// file (server/index.js), not the process's cwd, so it works regardless of
// where `node index.js` is launched from.
const CLIENT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'client');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStaticFile(req, res) {
  // Strip query string, decode percent-encoding, and normalize away any
  // '..' segments BEFORE joining onto CLIENT_DIR - without this a request
  // like '/../../../etc/passwd' (or its encoded form) could walk outside
  // the client directory entirely; normalize() collapses '..' segments
  // but only once they're part of the same path being joined, so this
  // check happens on the raw decoded segment, not after the join.
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const relativePath = safePath === '/' ? 'index.html' : safePath.replace(/^\//, '');
  const filePath = join(CLIENT_DIR, relativePath);
  // Belt-and-suspenders: confirm the resolved path is still inside
  // CLIENT_DIR even after the join, in case some other normalization edge
  // case slipped through above.
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      return serveStaticFile({ ...req, url: join(relativePath, 'index.html') }, res);
    }
    const data = await readFile(filePath);
    const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const httpServer = createServer((req, res) => {
  serveStaticFile(req, res);
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

// Broadcasts to every seat that's EVER been human-occupied (spectatorId),
// not just currently-in-control ones (playerId) - a seat that timed out
// and got handed to a bot should still keep its original player watching
// the match live as a spectator, not go dark on them (see the "keep
// sending updates after timeout" design decision - confirmed via a real
// bug where the client's screen just froze forever after a timeout, since
// the old playerId-only broadcast silently stopped reaching that tab the
// instant the seat converted to a bot).
function broadcastRoom(room, type, payload = {}) {
  for (const seat of room.seats) {
    if (seat.spectatorId) {
      const ws = sessions.get(seat.spectatorId);
      if (ws) send(ws, type, payload);
    }
  }
}

// Sends a per-recipient payload built from buildPayload(recipientSessionId)
// to every ever-human seat (see broadcastRoom above for why spectatorId,
// not playerId), instead of one shared broadcast object - needed wherever
// the payload must say "which seat is YOU" (a plain broadcast object is
// inherently the same for every recipient, and the client can't safely
// infer its own seat from anything else in the lobby view).
function broadcastPersonalized(room, type, buildPayload) {
  for (const seat of room.seats) {
    if (seat.spectatorId) {
      const ws = sessions.get(seat.spectatorId);
      if (ws) send(ws, type, buildPayload(seat.spectatorId));
    }
  }
}

// ---- Lobby snapshot sent to every client whenever room membership/picks change ----
function lobbyView(room, recipientSessionId) {
  const shape = roomShapeFor(room.roomType);
  return {
    code: room.code,
    roomType: room.roomType,
    picksPerSeat: shape.picksPerSeat,
    ownerId: room.ownerId,
    youAreOwner: room.ownerId === recipientSessionId,
    mySeatIndex: room.seats.find((s) => s.playerId === recipientSessionId)?.index ?? null,
    phase: room.phase,
    seats: room.seats.map((s) => ({
      index: s.index,
      kind: s.kind,
      name: s.name,
      characterIds: s.characterIds,
      isOwner: s.playerId === room.ownerId,
      isMe: s.playerId === recipientSessionId,
    })),
    availableCharacterIds: availableCharacterIds(room),
  };
}

function broadcastLobby(room) {
  broadcastPersonalized(room, 'lobby-update', (recipientSessionId) => ({ room: lobbyView(room, recipientSessionId) }));
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

// Serializable summary of what the acting character can legally do right
// now - the client renders buttons/targets off this instead of
// reimplementing isLegal()/isValidTarget() itself, which would duplicate
// the whole ability rules system client-side and open a mismatch/cheating
// surface (a client that computes its own legality could offer illegal
// moves; the server would still reject them via handleAction's own checks,
// but the UI would be misleading). getLegalActions()'s raw entries include
// an `execute` function that can't survive JSON - only the safe fields are
// picked out here.
function usableActionsFor(game, characterId) {
  const character = game.characters[characterId];
  if (!character) return [];
  return getUsableActions(character, game).map((a) => ({
    actionId: a.actionId,
    label: a.label,
    needsTarget: a.needsTarget,
    validTargetIds: a.needsTarget
      ? Object.keys(game.characters).filter((tid) => isValidTarget(game, characterId, a.actionId, tid))
      : [],
  }));
}

function broadcastGameState(room) {
  const acting = settleToNextDecision(room.game);
  if (room.game.phase === 'game-over') {
    room.phase = 'finished';
    clearTurnTimer(room);
  } else if (isBotControlled(room, acting)) {
    // Bots never time out (they always act on their own within
    // BOT_ACTION_DELAY_MS, see runBotTurnsIfAny) - arming the 30s human
    // timer for them is pure waste, and with paced bot turns now spending
    // real wall-clock time "between actions", skip it rather than
    // needlessly re-arm/clear every ~1.2s.
    clearTurnTimer(room);
  } else {
    armTurnTimer(room, acting);
  }
  broadcastRoom(room, 'game-state', {
    game: sanitizeGameForBroadcast(room.game),
    actingCharacterId: acting,
    usableActions: acting ? usableActionsFor(room.game, acting) : [],
    // Absolute timestamp (ms since epoch) the current turn's 30s timer
    // expires at - lets clients render a live countdown without their own
    // clock/timer bookkeeping, just `deadline - Date.now()` ticked locally.
    // null while no timer is armed (e.g. game just ended).
    turnDeadline: room.turnTimer ? room.turnDeadline : null,
    // Lets the client tell "solo vs bots" apart from "real opponents still
    // playing" - e.g. only offering a one-click Exit Game during a match
    // when there's nobody else around to leave hanging. state.room (the
    // last lobby-update) is stale mid-match under normal play, so this is
    // computed fresh here rather than relying on the client's old snapshot.
    humanCount: room.seats.filter((s) => s.kind === 'human').length,
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
    room.turnDeadline = null;
  }
}

function seatForCharacter(room, characterId) {
  return room.seats.find((s) => s.characterIds.includes(characterId));
}

function armTurnTimer(room, characterId) {
  clearTurnTimer(room);
  if (!characterId) return;
  room.turnDeadline = Date.now() + TURN_TIMER_DURATION_MS;
  room.turnTimer = setTimeout(() => {
    const seat = seatForCharacter(room, characterId);
    if (seat && seat.kind === 'human') {
      seat.kind = 'bot';
      seat.playerId = null;
      // Unlike a real leave/disconnect (leaveRoom), a timeout does NOT
      // transfer ownership away - the player is still connected and still
      // watching (spectatorId is deliberately kept, see leaveRoom's own
      // comment on that distinction), they just missed one 30s window. In
      // a solo-human-vs-bots match, stripping ownership here left the room
      // permanently ownerless the moment the lone human timed out even
      // once - room.ownerId set to null with no other human seat to hand
      // it to, so return-to-lobby/fill-bot/remove-bot/start-match (all
      // owner-gated) became unusable for the rest of that room's life,
      // even though its owner never actually left.
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

// Paced: resolves ONE bot action, broadcasts it immediately (so everyone
// watching sees who-attacked-whom one step at a time instead of a burst
// of turns flashing by faster than anyone can read), then waits
// BOT_ACTION_DELAY_MS before resolving the next one. Reported directly:
// with several consecutive bot turns (e.g. a 4-player match with 1 human),
// they used to all resolve in one synchronous tick, broadcasting only the
// final result - unreadable.
const BOT_ACTION_DELAY_MS = 3000;

function runBotTurnsIfAny(room) {
  // Guard against overlapping sequences: if a paced bot sequence is
  // already scheduled for this room (e.g. runBotTurnsIfAny got called
  // again from another path while one is still mid-flight), don't start a
  // second one stacked on top of it - the already-running sequence will
  // naturally pick up wherever the game state ends up.
  if (room.botSequenceActive) return;
  room.botSequenceActive = true;
  // The FIRST bot step also waits BOT_ACTION_DELAY_MS before acting, same
  // as every step after it - calling stepBotTurn() synchronously here would
  // execute the first bot's move in the same tick as whatever broadcast
  // just preceded this call (the triggering human action, or the previous
  // bot's own step), landing both in the same client-visible instant
  // instead of the intended pause between them.
  setTimeout(() => stepBotTurn(room), BOT_ACTION_DELAY_MS);
}

function stepBotTurn(room) {
  // The match this sequence was paced for may have been abandoned/reset
  // (Exit Game, return-to-lobby) while this step's setTimeout was still
  // pending - room.game is null in that case, nothing left to step.
  if (!room.game) {
    room.botSequenceActive = false;
    return;
  }
  const acting = settleToNextDecision(room.game);
  if (!acting || room.game.phase === 'game-over' || !isBotControlled(room, acting)) {
    room.botSequenceActive = false;
    broadcastGameState(room);
    return;
  }

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

  // Broadcast this single bot action right away, then pause before the
  // next one - this is what actually makes each bot move readable instead
  // of a burst.
  broadcastGameState(room);

  if (room.game.phase === 'game-over') {
    room.botSequenceActive = false;
    return;
  }
  setTimeout(() => stepBotTurn(room), BOT_ACTION_DELAY_MS);
}

// ---- Room/lobby message handlers ----
function sanitizeName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 20) : '';
}

function handleCreateRoom(ws, sessionId, { roomType, name }) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return send(ws, 'error', { message: 'A name is required.' });
  if (!roomShapeFor(roomType)) {
    return send(ws, 'error', { message: 'Invalid room type.' });
  }
  const room = createRoom(roomType);
  const seat = room.seats[0];
  seat.kind = 'human';
  seat.playerId = sessionId;
  seat.spectatorId = sessionId;
  seat.name = cleanName;
  room.ownerId = sessionId;
  send(ws, 'room-created', { code: room.code });
  broadcastLobby(room);
}

function handleJoinRoom(ws, sessionId, { code, name }) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return send(ws, 'error', { message: 'A name is required.' });
  const room = getRoom(code);
  if (!room) return send(ws, 'error', { message: 'Room not found.' });
  if (room.phase !== 'lobby') return send(ws, 'error', { message: 'Match already started.' });
  const seat = availableSeats(room)[0];
  if (!seat) return send(ws, 'error', { message: 'Room is full.' });
  seat.kind = 'human';
  seat.playerId = sessionId;
  seat.spectatorId = sessionId;
  seat.name = cleanName;
  send(ws, 'room-joined', { code: room.code });
  broadcastLobby(room);
}

function handlePickCharacter(room, sessionId, { characterId }) {
  if (room.phase !== 'lobby') return; // picks are frozen once a match has actually started
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
  if (room.phase !== 'lobby') return; // can't un-pick out from under an already-started/finished match
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

// Owner can undo a bot-fill back to an empty seat (e.g. they meant to
// leave it open for a friend to join) - only while still in the lobby, a
// bot seat mid/post-match can't un-fill since it's already playing a role
// in that match (or was, before return-to-lobby resets it back to empty
// automatically anyway - see resetRoomToLobby).
function handleRemoveBot(room, sessionId, { seatIndex }) {
  if (sessionId !== room.ownerId) return;
  if (room.phase !== 'lobby') return;
  const seat = room.seats[seatIndex];
  if (!seat || seat.kind !== 'bot') return;
  seat.kind = 'empty';
  seat.name = null;
  seat.characterIds = [];
  broadcastLobby(room);
}

function handleStartMatch(room, sessionId) {
  if (sessionId !== room.ownerId) return;
  // Every human-claimed seat must have finished picking before starting.
  // Empty seats block starting too - a deliberately removed bot must be
  // either refilled (Fill with Bot) or taken by a real player before the
  // match can start; there's no more silent auto-fill-on-start (that made
  // "Remove Bot" feel like a no-op, since the seat filled right back in
  // with a bot the instant Start was clicked anyway).
  if (room.seats.some((s) => s.kind === 'human' && !seatIsReady(room, s))) return;
  if (room.seats.some((s) => s.kind === 'empty')) return;
  const playerPicks = room.seats.map((s) => ({
    id: s.playerId || `bot-${s.index}`,
    name: s.name,
    characterIds: s.characterIds,
    isPC: s.kind === 'bot',
  }));
  room.game = createGame(room.roomType, playerPicks);
  room.phase = 'in-match';
  broadcastLobby(room);
  // Broadcast the fresh game state immediately, before any bot turns start
  // stepping - lobbyScreen.js switches straight to the battle screen the
  // instant it sees room.phase 'in-match' (via onEnterMatch), but with no
  // game-state broadcast yet, the client's OLD state.game from the
  // previous match (still phase:'game-over', still showing whoever just
  // won) was the only thing renderBattle had to draw from until the first
  // bot's paced move eventually arrived - so a fresh match starting with a
  // bot going first would flash the PREVIOUS match's victory screen for a
  // couple seconds before the real board appeared.
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

// "Back to menu" after a match ends returns everyone to THIS room's lobby
// (same code) rather than dropping the connection/room entirely - owner-only
// so one player can't yank the group back mid-celebration, and only valid
// once the match has actually finished.
function handleReturnToLobby(room, sessionId) {
  if (sessionId !== room.ownerId) return;
  if (room.phase !== 'finished') return;
  clearTurnTimer(room);
  resetRoomToLobby(room);
  broadcastLobby(room);
}

// "Exit Game" mid-match (solo owner vs bots only, per humanCount<=1 gating
// on the client) - immediately scraps the in-progress match with no winner
// declared and resets straight to a fresh lobby, same room code. Distinct
// from return-to-lobby (which only fires once a match has already ended
// naturally) and from leave-room (which removes the player from the room
// entirely) - this is "abandon what I'm playing, but stay in this room and
// pick again," owner-only for the same reason every other room-lifecycle
// action is.
function handleAbandonMatch(room, sessionId) {
  if (sessionId !== room.ownerId) return;
  if (room.phase !== 'in-match') return;
  clearTurnTimer(room);
  resetRoomToLobby(room);
  broadcastLobby(room);
}

// Shared by both an explicit "Exit Room" click (leave-room message) and a
// real socket disconnect (ws.on('close')) - same cleanup either way, since
// a deliberate exit and an abrupt disconnect should behave identically
// from the room's perspective. Unlike a timeout (which keeps spectatorId
// so the player keeps watching), leaving is a deliberate full exit - both
// playerId AND spectatorId are cleared, so this session stops receiving
// broadcasts for a room it explicitly left.
function leaveRoom(sessionId, ws) {
  const room = findRoomBySessionId(sessionId);
  if (!room) return;
  const seat = room.seats.find((s) => s.spectatorId === sessionId);
  if (!seat) return;
  // Confirm directly to the leaving client (not a room broadcast - they're
  // about to stop being part of the room) so it knows to switch back to
  // the entry screen rather than waiting on a lobby-update that will never
  // arrive for them again. Sent before the cleanup below in case ws is
  // already gone (a real disconnect calls this with no ws at all).
  if (ws) send(ws, 'left-room', {});

  if (room.phase === 'lobby') {
    // Nothing committed yet - just free the seat.
    seat.kind = 'empty';
    seat.playerId = null;
    seat.spectatorId = null;
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

  // Mid-match (or finished, waiting on return-to-lobby): leaving = permanent
  // bot takeover, same as a timed-out turn - but this session is fully done
  // with the room (spectatorId cleared too), unlike a timeout.
  const wasHuman = seat.kind === 'human';
  seat.kind = 'bot';
  seat.playerId = null;
  seat.spectatorId = null;
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
  if (wasHuman && room.phase === 'in-match') runBotTurnsIfAny(room);
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
    const soulSwapWrathTargets = Object.keys(room.game.characters).filter((tid) => isValidTarget(room.game, characterId, 'soulSwapWrath', tid));
    broadcastRoom(room, 'game-state', {
      game: sanitizeGameForBroadcast(room.game),
      actingCharacterId: characterId,
      awaitingSoulSwapWrath: true,
      usableActions: [{ actionId: 'soulSwapWrath', label: 'Thunder Wrath (free, from Soul Swap)', needsTarget: true, validTargetIds: soulSwapWrathTargets }],
    });
    return;
  }
  markCharacterActed(room.game, characterId);
  // Broadcast the human's own move on its own FIRST, before any bot turns
  // start stepping - otherwise the very first broadcast a client sees after
  // its own click already has the first bot's action folded into the same
  // log/state (stepBotTurn's own broadcast), making it look like both
  // actions landed simultaneously instead of BOT_ACTION_DELAY_MS apart.
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

function handleSoulSwapWrath(room, sessionId, { characterId, targetId }) {
  if (room.phase !== 'in-match' || !room.game) return;
  const seat = seatForCharacter(room, characterId);
  if (!seat || seat.playerId !== sessionId) return;
  if (!isValidTarget(room.game, characterId, 'soulSwapWrath', targetId)) return;
  executeAction(room.game, characterId, 'soulSwapWrath', targetId);
  markCharacterActed(room.game, characterId);
  broadcastGameState(room);
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
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

function isJesterBallPassTarget(game, holderId, targetId) {
  const t = game.characters[targetId];
  const holder = game.characters[holderId];
  if (!t || t.isKO || targetId === holderId) return false;
  // Boingo is never a Pass target - giving it back to him is always the
  // dedicated Return choice (heals him), not a Pass. Passing to your own
  // teammate is excluded too, same as every other targeted action. Matches
  // the main game's isValidBallDropTarget exactly.
  if (targetId === game.jesterBall.thrownByCharacterId) return false;
  if (t.ownerId === holder.ownerId) return false;
  return true;
}

// In-match/lobby text chat - relayed to everyone currently in the room, no
// history kept beyond what's already in each client's own chat panel (a
// player joining mid-lobby or reconnecting after a crash just doesn't see
// earlier messages, same "no persistence" tradeoff as everything else here).
function handleChatMessage(room, sessionId, { text }) {
  // spectatorId, not playerId - a timed-out/bot-taken-over player should
  // still be able to chat even though they can no longer act (see
  // findRoomBySessionId for the same reasoning).
  const seat = room.seats.find((s) => s.spectatorId === sessionId);
  if (!seat) return;
  // Short-sentence cap, not a full message board - keeps the compact chat
  // panel readable rather than needing to render long paragraphs.
  const clean = typeof text === 'string' ? text.trim().slice(0, 60) : '';
  if (!clean) return;
  // seatIndex (not just name) so the client can label messages "P1: name"
  // etc. - two players can pick the same display name, and even without a
  // clash it's a quick way to tell who's who against the seat list.
  broadcastRoom(room, 'chat-message', { name: seat.name, seatIndex: seat.index, text: clean, at: Date.now() });
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
    if (type === 'leave-room') return leaveRoom(sessionId, ws);

    const room = findRoomBySessionId(sessionId);
    if (!room) return;

    switch (type) {
      case 'pick-character': return handlePickCharacter(room, sessionId, payload);
      case 'unpick-character': return handleUnpickCharacter(room, sessionId, payload);
      case 'fill-bot': return handleFillBot(room, sessionId, payload);
      case 'remove-bot': return handleRemoveBot(room, sessionId, payload);
      case 'start-match': return handleStartMatch(room, sessionId);
      case 'return-to-lobby': return handleReturnToLobby(room, sessionId);
      case 'abandon-match': return handleAbandonMatch(room, sessionId);
      case 'action': return handleAction(room, sessionId, payload);
      case 'soul-swap-wrath': return handleSoulSwapWrath(room, sessionId, payload);
      case 'jester-ball-choice': return handleJesterBallChoice(room, sessionId, payload);
      case 'chat-message': return handleChatMessage(room, sessionId, payload);
      default: return;
    }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
    leaveRoom(sessionId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Soul Clash multiplayer server listening on port ${PORT}`);
});
