import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

import { CHARACTER_IDS } from '../client/js/characters.js';
import { createGame } from './engine/state.js';
import {
  getUsableActions, executeAction, isValidTarget, isValidMindControlTarget, markCharacterActed,
  finalizeAction, executeActionAsPuppet,
} from './engine/turnEngine.js';
import { applyDamage } from './engine/damagePipeline.js';
import {
  chooseBotMove, chooseBotJesterBallMove, chooseSoulSwapWrathTarget,
  chooseBotMelyssaPuppetAction,
} from './engine/botPlayer.js';
import { settleToNextDecision, finishJesterBall } from './gameFlow.js';
import {
  createRoom, getRoom, deleteRoom, findRoomBySessionId, roomShapeFor,
  availableSeats, availableCharacterIds, seatIsReady, resetRoomToLobby, TURN_TIMER_DURATION_MS,
} from './rooms.js';
import { TUTORIAL_SEQUENCES, TUTORIAL_SEQUENCES_1V2, tutorialBotCharacterId } from './data/tutorialSequences.js';

const PORT = process.env.PORT || 3001;

// Stamped onto index.html's own script tag (see serveStaticFile below) so
// every fresh page load pulls a brand-new URL for the client's entire JS
// module graph after each server restart/deploy. index.html itself is
// served 'no-cache', which SHOULD force revalidation on every load, but
// that's only as reliable as whatever sits between the browser and this
// server actually honoring it - a hosting platform's own static/CDN layer
// (confirmed a real risk after a live report: a client-side bug fix that
// worked correctly server-side, verified via a live protocol test, still
// silently failed to take effect in a real browser session on the current
// host) can silently cache .js files regardless of the header this process
// sends. Query-string busting sidesteps that entirely, the same trick
// assetVersion.js's v() already uses for images/audio.
const SERVER_BOOT_VERSION = String(Date.now());

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
    let data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    // Cache-busting for the client's ES module graph - see SERVER_BOOT_VERSION
    // above for why this exists (index.html's own no-cache header alone isn't
    // reliably enough on every host). A query string on the entry script
    // alone would NOT be enough: ES module imports resolve to their own URL
    // independently of how the importing script itself was fetched, so
    // './battleScreen.js' inside main.js is still a completely unversioned
    // request unless ITS OWN import specifier carries the param too. So both
    // rewrites are needed together: index.html's <script src> starts the
    // chain, and every .js file's own relative import specifiers propagate
    // it one level further - transitively covering the whole graph.
    if (ext === '.html' && relativePath.replace(/^[/\\]+/, '') === 'index.html') {
      data = Buffer.from(
        data.toString('utf8').replace('src="js/main.js"', `src="js/main.js?v=${SERVER_BOOT_VERSION}"`)
      );
    } else if (ext === '.js') {
      // Matches `from './x.js'` / `from "../y.js"` (single or double quotes,
      // any relative depth) - deliberately does NOT match bare/absolute
      // specifiers (there are none in this codebase; every import here is
      // relative), so this can't accidentally mangle a future external import.
      data = Buffer.from(
        data.toString('utf8').replace(
          /from\s+(['"])(\.\.?\/[^'"]+\.js)\1/g,
          (match, quote, path) => `from ${quote}${path}?v=${SERVER_BOOT_VERSION}${quote}`
        )
      );
    }
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };
    // Images/audio are static, content-addressed-in-spirit assets that
    // never change without a filename change - without a Cache-Control
    // header the browser has to re-validate (or worse, re-fetch) them on
    // every reload, which is exactly why battle portrait/flash images kept
    // "loading slowly" even after the client-side preload warmed the
    // in-page cache for a single session. HTML/JS/CSS stay uncached
    // (or short-lived) so a new deploy is picked up on next reload instead
    // of serving a stale bundle for a year.
    if (['.jpg', '.jpeg', '.png', '.svg', '.ico', '.mp3'].includes(ext)) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
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

// sessionId -> ws connection. A session's raw id itself never survives a
// disconnect (a fresh random one is issued on every new connection) - what
// DOES survive is the per-seat reconnectToken (see rooms.js's createSeat and
// handleReconnect below), which lets a returning browser prove which seat it
// used to hold within that seat's 60s disconnect grace period.
const sessions = new Map();

const DISCONNECT_GRACE_MS = 60_000;

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
    // Marks each character's one signature special ability (declared on the
    // action def in server/abilities/*.js) so the client can style that
    // button distinctly from a normal attack - not every character has one
    // (Blade has just his one repeatable Blood Hunt), so this is often
    // false/absent for every button.
    special: !!a.special,
    // mindControl routes through isValidMindControlTarget (ally-allowed),
    // never isValidTarget (enemy-only) - the one exception in the roster.
    validTargetIds: a.needsTarget
      ? Object.keys(game.characters).filter((tid) => (a.actionId === 'mindControl'
          ? isValidMindControlTarget(game, tid)
          : isValidTarget(game, characterId, a.actionId, tid)))
      : [],
  }));
}

// Computes the serializable option list for stage 2 of Mind Control (what
// the puppet can be made to do) - reuses usableActionsFor verbatim for the
// puppet's REAL options (never re-derived by hand), then layers in the
// Jester-Ball-holder forced choice and/or Self Choke as needed. Both
// server/index.js's own handlers and the bot flow (via chooseBotMelyssaPuppetAction,
// which calls getUsableActions directly rather than this function - see
// botPlayer.js) need this exact same option set for legality purposes, but
// only the human-facing path needs it SERIALIZED for broadcast, hence this
// lives here rather than in turnEngine.js.
function mindControlOptionsFor(game, melyssaId, puppetId) {
  const puppet = game.characters[puppetId];
  const isEnemyPuppet = puppet.ownerId !== game.characters[melyssaId].ownerId;

  const jb = game.jesterBall;
  if (jb && jb.holderCharacterId === puppetId) {
    const passTargets = Object.keys(game.characters).filter((tid) => isJesterBallPassTarget(game, puppetId, tid));
    const jbOptions = [
      { actionId: '__mcJesterBallTake', label: 'Take the Jester Ball (-4 hearts)', needsTarget: false, special: false, validTargetIds: [] },
    ];
    if (jb.passCount < 5) {
      jbOptions.push({ actionId: '__mcJesterBallPass', label: 'Pass the Jester Ball', needsTarget: true, special: false, validTargetIds: passTargets });
    }
    return isEnemyPuppet ? [...jbOptions, selfChokeOption()] : jbOptions;
  }

  const realOptions = usableActionsFor(game, puppetId);
  if (!isEnemyPuppet) return realOptions;
  return [...realOptions, selfChokeOption()];
}

function selfChokeOption() {
  // Short label - the panel is a compact button row (see battleScreen.js's
  // renderMindControlActionPanel), not a place for a full sentence; the
  // "1 flat damage, ignores shield" detail lives in the button's title
  // tooltip client-side instead, same as every other action's label here.
  return { actionId: '__mcSelfChoke', label: 'Self Choke', needsTarget: false, special: false, validTargetIds: [] };
}

// Self Choke: Melyssa's own move against an enemy puppet, NOT routed
// through either ability-module map (the puppet is the victim here, not
// the actor whose kit is being used). Deliberately uses characterId:
// melyssaId / targetId: puppetId in its log entry - the TRUE actor/victim -
// unlike every puppeted-real-action entry, which uses the puppet's own id
// as characterId. Do not "fix" this to match the puppet-action convention;
// it's intentional (see client/js/portraitFlash.js's dedicated Self-Choke
// flash check, which relies on this exact attribution).
function executeSelfChoke(game, melyssaId, puppetId) {
  const log = [];
  const result = applyDamage(game, log, {
    sourceCharacterId: melyssaId,
    targetCharacterId: puppetId,
    amount: 1,
    ignoresShield: true,
  });
  log.push({ type: 'attack', characterId: melyssaId, actionId: 'selfChoke', targetId: puppetId, ...result });
  finalizeAction(game, log, result, melyssaId, 'selfChoke', puppetId);
  return result;
}

// Marks a Mind-Control-driven turn as truly, fully over - used at every one
// of the exactly 3 points that's the case: handleMindControlAction's
// no-follow-up branch, finishBotMindControlTurn (bot equivalent), and the
// tutorial's final puppetOf-tagged step of a sequence. Replaces the bare
// markCharacterActed(..., melyssaId) call each of those sites would
// otherwise need, since Melyssa's turn also needs her own
// special.controlling flag cleared (ends the held selection portrait).
function finishMelyssaTurn(game, melyssaId) {
  markCharacterActed(game, melyssaId);
  game.characters[melyssaId].special.controlling = false;
}

// Shared broadcast shape for every "Melyssa is mid-Mind-Control, waiting on
// a decision for this puppet" moment - used by both the human path
// (handleAction's mindControl branch, handleMindControlAction's follow-up)
// and the bot path (stepBotTurn's mindControl branch, stepBotMindControlTurn's
// follow-up) so a spectator/opponent sees the exact same intermediate state
// regardless of who's actually driving Melyssa. Re-arms a fresh TURN_TIMER
// for a human-controlled Melyssa (without this, the timer from the START of
// her turn keeps counting down uninterrupted through every stage, and a
// slow decision could time out mid-sequence) - deliberately clears it
// instead for a bot-controlled seat, mirroring broadcastGameState's own
// isBotControlled branch, since a bot never needs (or should be exposed to)
// a human timeout while it's mid-sequence.
function broadcastMindControlStage(room, melyssaId, puppetId, usableActions) {
  room.melyssaControl = { melyssaCharacterId: melyssaId, puppetCharacterId: puppetId };
  if (isBotControlled(room, melyssaId)) {
    clearTurnTimer(room);
  } else {
    armTurnTimer(room, melyssaId);
  }
  broadcastRoom(room, 'game-state', {
    game: sanitizeGameForBroadcast(room.game),
    actingCharacterId: melyssaId,
    awaitingMindControlAction: true,
    mindControlPuppetId: puppetId,
    usableActions,
    turnDeadline: room.turnTimer ? room.turnDeadline : null,
  });
}

function broadcastGameState(room) {
  const acting = settleToNextDecision(room.game);
  if (room.game.phase === 'game-over') {
    room.phase = 'finished';
    clearTurnTimer(room);
  } else if (isBotControlled(room, acting) || isTutorialRoom(room)) {
    // Bots never time out (they always act on their own within
    // BOT_ACTION_DELAY_MS, see runBotTurnsIfAny) - arming the 30s human
    // timer for them is pure waste, and with paced bot turns now spending
    // real wall-clock time "between actions", skip it rather than
    // needlessly re-arm/clear every ~1.2s. Tutorial rooms ALSO never arm
    // the timer even for the human's own turn - a tutorial has no failure
    // state to auto-resolve into (there's no "wrong" auto-pick, only the
    // one scripted next move), and a timeout converting the human's seat
    // to 'bot' would corrupt the whole scripted sequence (the tutorial bot
    // step data is for the OPPONENT, not the human's own character).
    clearTurnTimer(room);
  } else {
    armTurnTimer(room, acting);
  }
  // The client needs to see the FULL normal usableActions list (so it can
  // render every button and grey out all but the one required this step),
  // not a server-filtered single-option list - so this stays the same
  // getUsableActions()-derived list for tutorial rooms as for every other
  // room type. tutorialRequiredActionId/TargetId (below) is the separate
  // field the client uses purely for its own disabling logic.
  const tutorialStep = isTutorialRoom(room) && acting === room.tutorial?.humanCharacterId
    ? currentTutorialStep(room)
    : null;
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
    tutorialRequiredActionId: tutorialStep?.actionId ?? null,
    tutorialRequiredTargetId: tutorialStep ? resolveTutorialTarget(room, tutorialStep) : null,
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
// final result - unreadable. Matches battleScreen.js's own client-side
// ACTION_LOCKOUT_MS (also 5000) - a human's action buttons stay disabled
// for the first 5s of their own turn too, so bots and humans share the
// same "turn just started, nothing acts instantly" pacing throughout a
// match, not just during bot-only stretches.
const BOT_ACTION_DELAY_MS = 5000;

function runBotTurnsIfAny(room) {
  // Guard against overlapping sequences: if a paced bot sequence is
  // already scheduled for this room (e.g. runBotTurnsIfAny got called
  // again from another path while one is still mid-flight), don't start a
  // second one stacked on top of it - the already-running sequence will
  // naturally pick up wherever the game state ends up.
  if (room.botSequenceActive) return;
  // Nothing to do if it's already a human's decision - every caller here
  // invokes this unconditionally after its own action (see handleAction
  // etc.), regardless of whether any bot actually needs to act. Scheduling
  // the BOT_ACTION_DELAY_MS timeout below anyway used to cause a
  // completely redundant broadcastGameState 3s later purely confirming
  // nothing had changed (stepBotTurn's own early-exit branch) - if that
  // landed while the human had just armed an action client-side
  // (battleScreen.js's armedAction, e.g. picked Cyclone Punch and was
  // about to pick a target), the resulting game-state broadcast reset
  // armedAction back to null (see main.js's game-state handler), silently
  // un-arming the action and dropping the player back to the button list -
  // reported as "clicking fast" reproducing it, which lines up exactly:
  // slow play lets this stray timeout fire and resolve long before the
  // player's next click, fast play means it can land mid-interaction.
  if (!room.game || !isBotControlled(room, settleToNextDecision(room.game))) return;
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

  if (isTutorialRoom(room)) {
    // Bypass chooseBotMove/chooseBotJesterBallMove entirely - the bot's
    // heuristics are irrelevant here (it only ever has one legal move for
    // its fixed character anyway), and the tutorial needs a fully
    // deterministic, pre-scripted move+damage, not the bot's normal
    // decision logic. The Boingo sequence's forced Jester Ball Take is
    // handled inside executeTutorialStep itself (via the synthetic
    // 'jesterBallTake' actionId), not here, so no isBallHolder branch is
    // needed - the scripted step data already knows exactly what to do.
    // `step.actor !== 'human'` (not `=== 'bot'`) so this also covers
    // tutorial3's literal-bot-id actor values (e.g. 'boingo', 'athena').
    const step = currentTutorialStep(room);
    if (step && step.actor !== 'human') {
      executeTutorialStep(room, step);
    }
  } else {
    const character = room.game.characters[acting];
    const isBallHolder = room.game.jesterBall && room.game.jesterBall.holderCharacterId === acting;
    if (isBallHolder) {
      const move = chooseBotJesterBallMove(character, room.game);
      finishJesterBall(room.game, move.choice, move.targetId);
    } else {
      const move = chooseBotMove(character, room.game);
      if (move && move.actionId === 'mindControl') {
        // Mind Control is NOT resolved inline here, unlike every other bot
        // move - it's a multi-stage decision (puppet select -> puppet
        // action -> possible follow-up), and a human player sees each of
        // those stages as its own paced beat (see battleScreen.js's 5s
        // lockout on both the target-select and puppet-action panels). A
        // bot resolving the whole thing synchronously in one tick made
        // Melyssa impossible to follow as a spectator/opponent - one
        // broadcast showed the puppet selected, acted, AND any follow-up
        // all already done. executeAction here only performs the puppet
        // SELECTION, broadcast via the same broadcastMindControlStage shape
        // the human path uses (so a spectator sees identical intermediate
        // state either way); stepBotMindControlTurn (below) paces every
        // subsequent stage the same BOT_ACTION_DELAY_MS apart, and is the
        // one that eventually calls markCharacterActed/clears `controlling`
        // once the whole sequence is genuinely over.
        const result = executeAction(room.game, acting, move.actionId, move.targetId);
        const puppetId = result.puppetCharacterId;
        const puppetOptions = mindControlOptionsFor(room.game, acting, puppetId);
        broadcastMindControlStage(room, acting, puppetId, puppetOptions);
        setTimeout(() => stepBotMindControlTurn(room, acting, puppetId), BOT_ACTION_DELAY_MS);
        return;
      }
      if (move) {
        executeAction(room.game, acting, move.actionId, move.targetId);
        if (move.actionId === 'soulSwap') {
          const wrathTarget = chooseSoulSwapWrathTarget(character, room.game);
          if (wrathTarget) executeAction(room.game, acting, 'soulSwapWrath', wrathTarget);
        }
      }
      markCharacterActed(room.game, acting);
    }
  }

  // Broadcast this single bot action right away, then pause before the
  // next one - this is what actually makes each bot move readable instead
  // of a burst.
  broadcastGameState(room);

  // Only schedule another step if it's ACTUALLY still a bot's turn next -
  // otherwise this fires BOT_ACTION_DELAY_MS later purely to discover
  // that (the early-return branch above), re-broadcasting a game-state
  // that already went out unchanged. If the human had armed an action in
  // the meantime (battleScreen.js's armedAction, picked an ability and was
  // about to pick a target), that stray broadcast reset it back to null
  // client-side (main.js's game-state handler) - silently un-arming the
  // action right as they were about to pick a target. This is what made
  // "click fast right as your turn starts" reproduce it, and playing slow
  // avoid it (the stray timer had long since fired and settled by then).
  if (room.game.phase === 'game-over' || !isBotControlled(room, settleToNextDecision(room.game))) {
    room.botSequenceActive = false;
    return;
  }
  setTimeout(() => stepBotTurn(room), BOT_ACTION_DELAY_MS);
}

// Paces exactly ONE sub-stage of a bot-controlled Melyssa's Mind Control
// turn per call (mirrors stepBotTurn's own one-action-per-tick promise,
// scoped to just this multi-stage move) - the puppet's real action or Self
// Choke, a Jester Ball Take/Pass decision, or a Soul-Swap-triggered Wrath
// follow-up. Broadcasts after each one and, if there's more to resolve
// (Take doesn't consume the puppet's turn; Soul Swap always chains into a
// free Wrath), schedules itself again after BOT_ACTION_DELAY_MS - otherwise
// this is where the whole Mind Control turn actually ends: finishMelyssaTurn
// (markCharacterActed + clearing special.controlling) only fires here, once,
// at the true end of the sequence, then the normal bot-turn pacing resumes
// via runBotTurnsIfAny exactly as if stepBotTurn itself had just finished.
function stepBotMindControlTurn(room, melyssaId, puppetId) {
  if (!room.game) { room.botSequenceActive = false; return; }
  const puppet = room.game.characters[puppetId];
  const decision = chooseBotMelyssaPuppetAction(puppet, room.game, melyssaId);

  if (decision.kind === 'selfChoke') {
    executeSelfChoke(room.game, melyssaId, puppetId);
    finishBotMindControlTurn(room, melyssaId); // broadcasts internally
    return;
  }

  if (decision.kind === 'jesterBall') {
    finishJesterBall(room.game, decision.choice, decision.targetId);
    // Take's flat -4 can itself KO the puppet outright - same gap as the
    // human path in handleMindControlAction, see its comment for why a
    // follow-up stage would otherwise offer a phantom action panel for an
    // already-dead puppet.
    if (decision.choice === 'take' && !room.game.characters[puppetId].isKO) {
      // Take doesn't consume the puppet's turn - same as the human path,
      // the puppet also normal-acts as its own separate paced stage next.
      // Still mid-sequence (not a terminal broadcast), so this uses the
      // same awaitingMindControlAction shape as every other in-progress
      // stage, not the generic broadcastGameState. A second ball-holder
      // scenario for the SAME puppet is impossible immediately after Take
      // (Take clears game.jesterBall entirely) - no infinite pacing loop risk.
      const nextOptions = mindControlOptionsFor(room.game, melyssaId, puppetId);
      broadcastMindControlStage(room, melyssaId, puppetId, nextOptions);
      setTimeout(() => stepBotMindControlTurn(room, melyssaId, puppetId), BOT_ACTION_DELAY_MS);
    } else {
      finishBotMindControlTurn(room, melyssaId); // broadcasts internally
    }
    return;
  }

  // decision.kind === 'realAction'
  executeActionAsPuppet(room.game, melyssaId, puppetId, decision.actionId, decision.targetId);
  const wrathTarget = decision.actionId === 'soulSwap' ? chooseSoulSwapWrathTarget(puppet, room.game) : null;
  if (wrathTarget) {
    // Same reasoning as the Take case above - still mid-sequence, so this
    // broadcasts the awaiting-decision shape (a single soulSwapWrath
    // option) rather than a terminal one.
    broadcastMindControlStage(room, melyssaId, puppetId, [
      { actionId: 'soulSwapWrath', label: 'Thunder Wrath (free, from Soul Swap)', needsTarget: true, special: false, validTargetIds: [wrathTarget] },
    ]);
    setTimeout(() => {
      if (!room.game) { room.botSequenceActive = false; return; }
      executeActionAsPuppet(room.game, melyssaId, puppetId, 'soulSwapWrath', wrathTarget);
      finishBotMindControlTurn(room, melyssaId); // broadcasts internally
    }, BOT_ACTION_DELAY_MS);
    return;
  }

  finishBotMindControlTurn(room, melyssaId); // broadcasts internally
}

function finishBotMindControlTurn(room, melyssaId) {
  // Cleared here for the same reason the human path clears it (see
  // handleMindControlAction) - stale room.melyssaControl left over from a
  // just-finished bot sequence could otherwise wrongly validate/reject a
  // human's UNRELATED next action if they reconnect into this seat right
  // after a bot-driven Mind Control turn completes.
  room.melyssaControl = null;
  finishMelyssaTurn(room.game, melyssaId);
  broadcastGameState(room);
  room.botSequenceActive = false;
  runBotTurnsIfAny(room);
}

// ---- Tutorial mode: a scripted human-vs-bot(s) sequence (see
// server/data/tutorialSequences.js) where the bot's moves AND their
// damage, and the human's own next-allowed move, are both fully
// predetermined rather than driven by chooseBotMove/normal legality
// alone. room.tutorial lives alongside room.game (not part of the engine's
// own game object) and is the single source of truth for "what happens
// next" - stepIndex walks through the interleaved human+bot step list in
// order. Two room types: 'tutorial' (strict 1v1, every character except
// Velorya) and 'tutorial3' (1v2, Velorya only - needs a genuine second
// enemy to demonstrate Moonstep's real target-switch bonus). ----
function isTutorialRoom(room) {
  return room.roomType === 'tutorial' || room.roomType === 'tutorial3';
}

// A step's `actor` field is either 'human', the legacy 1v1 sentinel 'bot'
// (resolves to the single room.tutorial.botCharacterId, for every existing
// strict-1v1 tutorial's sequence data - left unchanged rather than mass-
// edited to literal ids), or - for a multi-bot room like Velorya's 1v2 -
// a LITERAL bot character id (e.g. 'boingo', 'athena'), which is already
// exactly the character id and needs no lookup at all.
function resolveTutorialActor(room, step) {
  if (step.actor === 'human') return room.tutorial.humanCharacterId;
  if (step.actor === 'bot') return room.tutorial.botCharacterId;
  return step.actor;
}

// `targetId: 'opponent'` resolves to "the one enemy" - only valid in a
// strict 1v1 room (every tutorial except Velorya's 1v2). Multi-bot
// sequences must always use a literal target id instead (never 'opponent',
// which would be ambiguous with 2 possible enemies) - already true of
// every step in the velorya1v2 sequence.
function resolveTutorialTarget(room, step) {
  if (step.targetId !== 'opponent') return step.targetId;
  const actingCharacterId = resolveTutorialActor(room, step);
  return actingCharacterId === room.tutorial.humanCharacterId ? room.tutorial.botCharacterId : room.tutorial.humanCharacterId;
}

function currentTutorialStep(room) {
  return room.tutorial.sequence[room.tutorial.stepIndex] ?? null;
}

// Executes the CURRENT scripted step for whichever side (human or bot) it
// belongs to, then advances stepIndex. Called from handleAction/
// handleSoulSwapWrath (human steps, after their own gate confirms the
// incoming action matches) and from stepBotTurn's tutorial branch (bot
// steps). Centralizing the actual execution here (rather than duplicating
// it at each call site) keeps the forced-amount/ignoresShield wiring and
// the stepIndex advancement in one place.
function executeTutorialStep(room, step) {
  const targetId = resolveTutorialTarget(room, step);
  const extra = step.forcedAmount != null ? { forcedAmount: step.forcedAmount, ignoresShield: step.ignoresShield } : undefined;
  const actingCharacterId = resolveTutorialActor(room, step);

  if (step.actionId === 'jesterBallTake') {
    // Synthetic marker (see tutorialSequences.js) - routed to
    // finishJesterBall directly rather than executeAction/the ability map,
    // matching how Take is actually resolved for a real Jester Ball holder.
    finishJesterBall(room.game, 'take', extra);
  } else if (step.actionId === '__mcSelfChoke') {
    // Self Choke is Melyssa's own move against her puppet, never a real
    // ability-module action (see the live '__mcSelfChoke' handling in
    // handleMindControlAction) - executeActionAsPuppet/executeAction would
    // look it up in ABILITY_MODULES[puppetOf].actions and find nothing.
    // step.puppetOf here is the VICTIM (the puppet being choked), not an
    // actor whose kit is being borrowed - actingCharacterId is Melyssa's own.
    executeSelfChoke(room.game, actingCharacterId, step.puppetOf);
    finishMelyssaTurn(room.game, actingCharacterId);
  } else if (step.puppetOf) {
    // Mind Control stage-2+: actingCharacterId is Melyssa's own id (the
    // seat that must click/be driven), but the actual executeAction
    // identity is the PUPPET (step.puppetOf, a literal characterId
    // hardcoded in the step data itself - every tutorial step is already a
    // fully pre-determined literal, same as every other step's targetId).
    executeActionAsPuppet(room.game, actingCharacterId, step.puppetOf, step.actionId, targetId, extra);
    if (step.actionId !== 'soulSwap') {
      finishMelyssaTurn(room.game, actingCharacterId);
    }
  } else {
    executeAction(room.game, actingCharacterId, step.actionId, targetId, extra);
    // Soul Swap and mindControl both don't mark the character acted yet -
    // same as the real (non-tutorial) handlers, they still owe a follow-up
    // step (soulSwapWrath, or the puppet's own action/__mcSelfChoke) before
    // the turn is actually over. Every other plain step marks acted
    // normally. Missing the mindControl case here was a real bug: without
    // it, settleToNextDecision advanced straight past Melyssa to the next
    // character's real turn the instant she PICKED a puppet, before the
    // puppet's own action step could ever be submitted/accepted.
    if (step.actionId !== 'soulSwap' && step.actionId !== 'mindControl') {
      markCharacterActed(room.game, actingCharacterId);
    }
  }
  room.tutorial.stepIndex += 1;
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
  seat.reconnectToken = randomUUID();
  room.ownerId = sessionId;
  send(ws, 'room-created', { code: room.code, seatIndex: seat.index, reconnectToken: seat.reconnectToken });
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
  seat.reconnectToken = randomUUID();
  send(ws, 'room-joined', { code: room.code, seatIndex: seat.index, reconnectToken: seat.reconnectToken });
  broadcastLobby(room);
}

// One-click tutorial room: unlike a normal room, this skips the whole
// pick-character -> fill-bot -> start-match lobby flow entirely - the
// human's one character pick arrives in this same message, the opponent(s)
// are derived automatically, and the match starts immediately. Velorya is
// the one special case - she needs a genuine second enemy (a 'tutorial3'
// room, 1v2) to demonstrate Moonstep's real target-switch bonus, which is
// structurally impossible to show honestly in a strict 1v1. Every other
// character uses the normal 1v1 'tutorial' room.
function handleCreateTutorialRoom(ws, sessionId, { name, characterId }) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return send(ws, 'error', { message: 'A name is required.' });
  if (!CHARACTER_IDS.includes(characterId)) return send(ws, 'error', { message: 'Invalid character.' });

  if (characterId === 'velorya') return createVeloryaTutorialRoom(ws, sessionId, cleanName);
  if (characterId === 'melyssa') return createMelyssaTutorialRoom(ws, sessionId, cleanName);
  if (!TUTORIAL_SEQUENCES[characterId]) return send(ws, 'error', { message: 'Tutorial not available for this character yet.' });

  const room = createRoom('tutorial');
  const humanSeat = room.seats[0];
  humanSeat.kind = 'human';
  humanSeat.playerId = sessionId;
  humanSeat.spectatorId = sessionId;
  humanSeat.name = cleanName;
  humanSeat.characterIds = [characterId];
  room.ownerId = sessionId;

  const botCharacterId = tutorialBotCharacterId(characterId);
  const botSeat = room.seats[1];
  fillSeatWithTutorialBot(botSeat, botCharacterId);

  room.tutorial = {
    humanCharacterId: characterId,
    botCharacterId,
    sequence: TUTORIAL_SEQUENCES[characterId],
    stepIndex: 0,
  };

  const playerPicks = room.seats.map((s) => ({
    id: s.playerId || `bot-${s.index}`,
    name: s.name,
    characterIds: s.characterIds,
    isPC: s.kind === 'bot',
  }));
  room.game = createGame('tutorial', playerPicks);
  if (characterId === 'blade') {
    // Athena needs slightly MORE than her normal 7 hearts here (not less) -
    // Blade's Rebirth and Athena's own KO are driven by the exact same
    // cumulative mirror-damage sequence once her curse is live (a 1:1
    // mirror of whatever she takes), so with both starting at 7 they always
    // hit 0 on the identical hit - Rebirth would fire in the SAME instant
    // the match ends, giving the player no beat to actually see it before
    // the win screen takes over. Bumping her to 8 makes Rebirth land one
    // hit early (turn 4, Blade 4->0->revived to 2, Athena left at 1) with
    // the kill happening on a separate later hit (turn 5, post-rebirth
    // streak reset to a safe 1 damage) - two distinct beats instead of one.
    // Hand-verified: this is the smallest change that decouples them while
    // keeping Blade safely above 0 on the finishing hit (revived to 2,
    // streak resets to 0 after Rebirth so the next hit is only 1 damage).
    room.game.characters.athena.hearts = 8;
    room.game.characters.athena.maxHearts = 8;
  }
  room.phase = 'in-match';
  send(ws, 'room-created', { code: room.code });
  broadcastLobby(room);
  // Human always goes first in a tutorial (see tutorialSequences.js) - no
  // runBotTurnsIfAny() kickoff needed here, unlike a normal match's
  // handleStartMatch, which may need the bot to move first.
  broadcastGameState(room);
}

// Velorya's 1v2 tutorial: seat 0 = human, seat 1 = Boingo (bot), seat 2 =
// Athena (bot, custom 2 max hearts - deliberately fragile, per design).
// Turn order is fixed by seat index (Velorya -> Boingo -> Athena -> repeat,
// confirmed generic in the engine), so no special turn-order logic is
// needed beyond creating the seats in the right order.
function createVeloryaTutorialRoom(ws, sessionId, cleanName) {
  const room = createRoom('tutorial3');
  const humanSeat = room.seats[0];
  humanSeat.kind = 'human';
  humanSeat.playerId = sessionId;
  humanSeat.spectatorId = sessionId;
  humanSeat.name = cleanName;
  humanSeat.characterIds = ['velorya'];
  room.ownerId = sessionId;

  fillSeatWithTutorialBot(room.seats[1], 'boingo');
  fillSeatWithTutorialBot(room.seats[2], 'athena');

  room.tutorial = {
    humanCharacterId: 'velorya',
    sequence: TUTORIAL_SEQUENCES_1V2.velorya,
    stepIndex: 0,
  };

  const playerPicks = room.seats.map((s) => ({
    id: s.playerId || `bot-${s.index}`,
    name: s.name,
    characterIds: s.characterIds,
    isPC: s.kind === 'bot',
  }));
  room.game = createGame('tutorial3', playerPicks);
  // Athena's custom 2-max-hearts override for this tutorial only - applied
  // directly on the created character rather than threading a per-seat
  // hearts override through createCharacter/createGame's general-purpose
  // signature, which every other room type also calls.
  room.game.characters.athena.hearts = 2;
  room.game.characters.athena.maxHearts = 2;
  room.phase = 'in-match';
  send(ws, 'room-created', { code: room.code });
  broadcastLobby(room);
  broadcastGameState(room);
}

// Melyssa's 1v2 tutorial: seat 0 = human, seat 1 = Velorya (bot), seat 2 =
// Tharox (bot), both custom 3 max hearts - deliberately fragile, same
// "keep the scripted sequence a reasonable length" reasoning as Athena's
// 2-heart override above. Same structural need as Velorya's own tutorial:
// Mind Control (puppeting ANY other character, ally or enemy, into their
// real kit) is impossible to demonstrate honestly ("puppet an enemy into
// attacking the OTHER enemy") with only one enemy on the board. Turn order
// fixed by seat index (Melyssa -> Velorya -> Tharox -> repeat) - Velorya
// MUST act right before Tharox each round for the shield lesson to land
// honestly (see the long comment on TUTORIAL_SEQUENCES_1V2.melyssa for why
// the reverse order doesn't work).
function createMelyssaTutorialRoom(ws, sessionId, cleanName) {
  const room = createRoom('tutorial3');
  const humanSeat = room.seats[0];
  humanSeat.kind = 'human';
  humanSeat.playerId = sessionId;
  humanSeat.spectatorId = sessionId;
  humanSeat.name = cleanName;
  humanSeat.characterIds = ['melyssa'];
  room.ownerId = sessionId;

  fillSeatWithTutorialBot(room.seats[1], 'velorya');
  fillSeatWithTutorialBot(room.seats[2], 'tharox');

  room.tutorial = {
    humanCharacterId: 'melyssa',
    sequence: TUTORIAL_SEQUENCES_1V2.melyssa,
    stepIndex: 0,
  };

  const playerPicks = room.seats.map((s) => ({
    id: s.playerId || `bot-${s.index}`,
    name: s.name,
    characterIds: s.characterIds,
    isPC: s.kind === 'bot',
  }));
  room.game = createGame('tutorial3', playerPicks);
  room.game.characters.velorya.hearts = 3;
  room.game.characters.velorya.maxHearts = 3;
  room.game.characters.tharox.hearts = 3;
  room.game.characters.tharox.maxHearts = 3;
  room.phase = 'in-match';
  send(ws, 'room-created', { code: room.code });
  broadcastLobby(room);
  broadcastGameState(room);
}

// Parallel to fillSeatWithBot, but deterministic - a tutorial's opponent is
// always exactly one fixed character, never randomly drawn from the pool.
function fillSeatWithTutorialBot(seat, characterId) {
  seat.kind = 'bot';
  seat.name = 'Bot';
  seat.characterIds = [characterId];
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

// Owner-only, lobby-phase-only (never mid-match - see the room.phase
// check) removal of another HUMAN player from the room, distinct from
// Remove Bot (that only ever un-fills a bot seat). Mirrors leaveRoom's own
// "still in lobby" branch exactly (free the seat back to empty, hand off
// ownership if the kicked player somehow was the owner - not reachable
// today since only the owner can kick, but kept for symmetry/future-
// proofing), except the kicked player didn't initiate this themselves, so
// they need an explicit notice (not the generic 'left-room' a real Exit
// Room click gets) telling them what happened rather than a message that
// would read as a random disconnect.
function handleKickPlayer(room, sessionId, { seatIndex }) {
  if (sessionId !== room.ownerId) return;
  if (room.phase !== 'lobby') return;
  const seat = room.seats[seatIndex];
  if (!seat || seat.kind !== 'human') return;
  if (seat.playerId === sessionId) return; // can't kick yourself
  const kickedWs = seat.spectatorId ? sessions.get(seat.spectatorId) : null;
  if (kickedWs) send(kickedWs, 'kicked', {});
  seat.kind = 'empty';
  seat.playerId = null;
  seat.spectatorId = null;
  seat.name = null;
  seat.characterIds = [];
  broadcastLobby(room);
}

// Owner-only, lobby-phase-only reordering: swaps a seat with its neighbor
// one position up or down (direction: -1 or 1) - matches the Up/Down arrow
// buttons in lobbyScreen.js rather than an arbitrary drag-and-drop
// permutation, which keeps validation trivial (just a bounds check, no
// need to verify an incoming array is a genuine permutation of every seat).
// Seat index directly determines turn order once the match starts
// (handleStartMatch builds playerPicks straight from room.seats' array
// order) - this is the whole point of the feature, letting the owner
// decide who acts first/second/etc. before starting.
//
// Physically swaps the array elements AND renumbers each seat's own .index
// to match its new position, keeping the array-position === seat.index
// invariant every other seatIndex-addressed handler (fill-bot, remove-bot,
// kick-player) depends on. This intentionally invalidates any client's
// stale localStorage seatIndex from before the swap - handleReconnect
// looks seats up by matching reconnectToken instead of trusting the
// client's seatIndex for exactly this reason, so a reorder never breaks
// reconnection for a currently-connected or later-reconnecting player.
function handleReorderSeats(room, sessionId, { seatIndex, direction }) {
  if (sessionId !== room.ownerId) return;
  if (room.phase !== 'lobby') return;
  if (direction !== -1 && direction !== 1) return;
  const otherIndex = seatIndex + direction;
  if (seatIndex < 0 || seatIndex >= room.seats.length) return;
  if (otherIndex < 0 || otherIndex >= room.seats.length) return;
  const seat = room.seats[seatIndex];
  const other = room.seats[otherIndex];
  room.seats[seatIndex] = other;
  room.seats[otherIndex] = seat;
  other.index = seatIndex;
  seat.index = otherIndex;
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

// Permanent bot takeover of a seat that's done for good - no more
// reconnecting back into it (spectatorId/reconnectToken both cleared, unlike
// a turn-timeout which keeps spectatorId so the original human can keep
// watching). Shared by: a deliberate "Exit Room"/disconnect with no active
// grace period (leaveRoom's mid-match branch below), and a disconnect grace
// period (see ws.on('close')) that expired with nobody reclaiming the seat.
// Returns the room to a clean state (ownership handoff, room deletion if no
// humans remain) exactly as leaveRoom always has.
function permanentlyConvertSeatToBot(room, seat, wasOwner) {
  seat.kind = 'bot';
  seat.playerId = null;
  seat.spectatorId = null;
  seat.reconnectToken = null;
  if (seat.disconnectTimer) clearTimeout(seat.disconnectTimer);
  seat.disconnectTimer = null;
  seat.disconnectDeadline = null;
  if (wasOwner) {
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
  if (room.phase === 'in-match') runBotTurnsIfAny(room);
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
  // with the room (spectatorId cleared too), unlike a timeout. An explicit
  // "Exit Room" click always goes straight to permanent (no grace period -
  // that's reserved for genuine disconnects, see ws.on('close')); a real
  // disconnect reaching here means the seat had no reconnectToken to begin
  // with (e.g. a tutorial room) since a reconnectable seat's close handler
  // diverts to the grace period instead of ever calling leaveRoom directly.
  permanentlyConvertSeatToBot(room, seat, room.ownerId === sessionId);
}

// Starts a 60s grace period for a seat whose connection just genuinely
// dropped mid-match (heartbeat-detected dead socket, or a real close event) -
// called only for seats that have a reconnectToken (i.e. claimed via
// handleCreateRoom/handleJoinRoom, never a tutorial seat) and only while
// room.phase === 'in-match'. The seat plays as a bot for the duration
// (identical visible behavior to a permanent takeover - no separate
// "temporarily disconnected" UI state), but keeps spectatorId/reconnectToken
// alive so handleReconnect below can find and restore it. If nobody
// reconnects before the timer fires, it converts exactly like a deliberate
// leave (permanentlyConvertSeatToBot).
function startDisconnectGracePeriod(room, seat, wasOwner) {
  seat.kind = 'bot';
  seat.playerId = null;
  seat.disconnectDeadline = Date.now() + DISCONNECT_GRACE_MS;
  seat.disconnectTimer = setTimeout(() => {
    permanentlyConvertSeatToBot(room, seat, wasOwner);
  }, DISCONNECT_GRACE_MS);
  // Ownership is NOT handed off yet (unlike a deliberate leave) - the
  // original owner might reconnect within the grace period and should get
  // their room control back exactly as it was, same reasoning as
  // armTurnTimer's own timeout not stripping ownership for a still-connected
  // player. If the grace period actually expires, permanentlyConvertSeatToBot
  // (called above) does the real ownership handoff then.
  broadcastLobby(room);
  if (room.phase === 'in-match') runBotTurnsIfAny(room);
}

function handleReconnect(ws, sessionId, { code, reconnectToken }) {
  const room = getRoom(code);
  if (!room) return send(ws, 'reconnect-failed', {});
  // Looked up by matching token, not by trusting the client's own
  // (possibly stale) seatIndex - seats can be reordered in the lobby
  // (handleReorderSeats), which renumbers seat.index, so a client's
  // localStorage-persisted seatIndex from before a reorder could otherwise
  // point at the WRONG seat entirely after a refresh. The token alone is
  // already the real security boundary (see below), so there's no reason
  // to also depend on the array position staying stable.
  const seat = room.seats.find((s) => s.reconnectToken === reconnectToken);
  if (!seat) return send(ws, 'reconnect-failed', {});
  // The token itself (a random UUID, unguessable, issued once at seat-claim
  // time and never exposed anywhere but this seat's own client) IS the
  // security boundary - anyone who has it correct is the seat's legitimate
  // owner, full stop. There's no additional liveness check (e.g. requiring
  // an active disconnectTimer, or the old socket's readyState reporting
  // closed) - a real network drop can leave the OLD connection reporting
  // OPEN for a long time (a proxy/load-balancer layer, like Render's, may
  // not surface the drop immediately), while the client's own faster local
  // detection lets the player reconnect before the server's heartbeat has
  // caught up. A liveness gate here rejected exactly that legitimate, fast
  // reconnect - confirmed live. Force-closing whatever's currently in the
  // seat (if anything) handles a still-technically-open old socket safely.
  if (seat.disconnectTimer) {
    clearTimeout(seat.disconnectTimer);
    seat.disconnectTimer = null;
    seat.disconnectDeadline = null;
  }
  // If the old connection is still technically open (the exact case this
  // fix targets), forcibly close it rather than leaving two sockets both
  // believing they own this seat - the old one's own close handler will
  // then find spectatorId already reassigned below and safely no-op (see
  // leaveRoom/ws.on('close')'s findRoomBySessionId lookup).
  const oldSessionId = seat.spectatorId;
  const oldWs = oldSessionId ? sessions.get(oldSessionId) : null;
  if (oldWs && oldWs !== ws && oldWs.readyState === oldWs.OPEN) oldWs.terminate();
  // If this seat WAS the room's owner (room.ownerId still points at its old
  // sessionId - startDisconnectGracePeriod deliberately leaves ownership
  // untouched during the grace period, clearing only playerId, so a
  // reconnecting owner gets control back exactly as it was, not handed off
  // to someone else), the new sessionId needs to take over as ownerId too.
  // oldSessionId (still preserved in spectatorId even mid-grace-period) is
  // what lets this compare against the RIGHT id - seat.playerId is already
  // null by this point (cleared at disconnect time), so comparing against
  // that would never match. Without this fix, an owner who disconnects and
  // reconnects mid-match keeps playing fine but silently loses every
  // owner-only ability (no "(owner)" label, Fill with Bot/Start Match/Kick
  // all silently no-op) for the rest of that room's life.
  if (room.ownerId === oldSessionId) room.ownerId = sessionId;
  seat.kind = 'human';
  seat.playerId = sessionId;
  seat.spectatorId = sessionId;
  broadcastLobby(room);
  if (room.game) broadcastGameState(room);
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
  if (actionDef.needsTarget) {
    // mindControl is the one action allowed to target allies - routes
    // through isValidMindControlTarget instead of the enemy-only isValidTarget.
    const validNow = actionId === 'mindControl'
      ? isValidMindControlTarget(room.game, targetId)
      : isValidTarget(room.game, characterId, actionId, targetId);
    if (!validNow) return;
  }
  // Tutorial rooms only ever accept the one scripted next step - this runs
  // IN ADDITION TO the normal legality checks above (never instead of
  // them), as a consistency safeguard: every scripted step was designed to
  // also be a genuinely legal move, so both checks passing is expected,
  // not redundant.
  if (isTutorialRoom(room)) {
    const step = currentTutorialStep(room);
    if (!step || step.actor !== 'human' || step.actionId !== actionId) return;
    if (resolveTutorialTarget(room, step) !== (targetId ?? null)) return;
    executeTutorialStep(room, step);
    if (actionId === 'soulSwap') {
      const nextStep = currentTutorialStep(room);
      broadcastRoom(room, 'game-state', {
        game: sanitizeGameForBroadcast(room.game),
        actingCharacterId: characterId,
        awaitingSoulSwapWrath: true,
        usableActions: [{ actionId: 'soulSwapWrath', label: 'Thunder Wrath (free, from Soul Swap)', needsTarget: true, validTargetIds: [resolveTutorialTarget(room, nextStep)] }],
        tutorialRequiredActionId: nextStep?.actionId ?? null,
        tutorialRequiredTargetId: nextStep ? resolveTutorialTarget(room, nextStep) : null,
      });
      return;
    }
    if (actionId === 'mindControl') {
      const nextStep = currentTutorialStep(room);
      const puppetId = nextStep?.puppetOf;
      const puppetOptions = puppetId ? mindControlOptionsFor(room.game, characterId, puppetId) : [];
      // Without this, handleMindControlAction's own room.melyssaControl
      // check (its very first gate, before any tutorial-specific logic)
      // rejects the follow-up submission unconditionally - the tutorial's
      // stage-2 step would never be reachable at all.
      room.melyssaControl = { melyssaCharacterId: characterId, puppetCharacterId: puppetId };
      broadcastRoom(room, 'game-state', {
        game: sanitizeGameForBroadcast(room.game),
        actingCharacterId: characterId,
        awaitingMindControlAction: true,
        mindControlPuppetId: puppetId,
        usableActions: puppetOptions,
        tutorialRequiredActionId: nextStep?.actionId ?? null,
        tutorialRequiredTargetId: nextStep ? resolveTutorialTarget(room, nextStep) : null,
      });
      return;
    }
    broadcastGameState(room);
    runBotTurnsIfAny(room);
    return;
  }

  if (actionId === 'mindControl') {
    const result = executeAction(room.game, characterId, actionId, targetId);
    const puppetId = result.puppetCharacterId;
    const puppetOptions = mindControlOptionsFor(room.game, characterId, puppetId);
    broadcastMindControlStage(room, characterId, puppetId, puppetOptions);
    return;
  }

  executeAction(room.game, characterId, actionId, targetId);

  if (actionId === 'soulSwap') {
    // Soul Swap doesn't mark the character acted yet - the free follow-up
    // Thunder Wrath (soulSwapWrath) still needs a target, same as the
    // client's zerathysSoulSwapFollowUpPending flow. Broadcast the
    // intermediate state (swap already applied) so clients show it, then
    // wait for a soulSwapWrath action message from this same player.
    const soulSwapWrathTargets = Object.keys(room.game.characters).filter((tid) => isValidTarget(room.game, characterId, 'soulSwapWrath', tid));
    // Same reasoning as the mindControl branch above - this is a distinct
    // decision stage bypassing broadcastGameState, so it needs its own
    // explicit re-arm or the original turn-start timer keeps counting down
    // through it unnoticed.
    armTurnTimer(room, characterId);
    broadcastRoom(room, 'game-state', {
      game: sanitizeGameForBroadcast(room.game),
      actingCharacterId: characterId,
      awaitingSoulSwapWrath: true,
      usableActions: [{ actionId: 'soulSwapWrath', label: 'Thunder Wrath (free, from Soul Swap)', needsTarget: true, validTargetIds: soulSwapWrathTargets }],
      turnDeadline: room.turnDeadline,
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
  // Zerathys's tutorial sequence has a scripted soulSwapWrath step - this
  // handler is a completely separate function from handleAction (a human's
  // Soul Swap doesn't auto-fire its own follow-up, unlike a bot's), so it
  // needs its own tutorial gate too, not just handleAction's.
  if (isTutorialRoom(room)) {
    const step = currentTutorialStep(room);
    if (!step || step.actor !== 'human' || step.actionId !== 'soulSwapWrath') return;
    if (resolveTutorialTarget(room, step) !== targetId) return;
    executeTutorialStep(room, step);
    broadcastGameState(room);
    runBotTurnsIfAny(room);
    return;
  }
  executeAction(room.game, characterId, 'soulSwapWrath', targetId);
  markCharacterActed(room.game, characterId);
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

// Stage 2 of Mind Control: Melyssa has already selected a puppet (stage 1,
// handled inside handleAction's 'mindControl' branch above, which stored
// room.melyssaControl and broadcast the puppet's options). This resolves
// what that puppet actually does - a real action, Self Choke, or a forced
// Jester Ball Pass/Take - and, unless there's a follow-up (a forced Take
// that doesn't consume the puppet's turn, or a puppeted Soul Swap's free
// Thunder Wrath), finishes Melyssa's whole turn.
function handleMindControlAction(room, sessionId, { characterId, puppetId, actionId, targetId }) {
  if (room.phase !== 'in-match' || !room.game) return;
  const seat = seatForCharacter(room, characterId);
  if (!seat || seat.playerId !== sessionId) return; // Melyssa's own seat, not the puppet's
  const acting = settleToNextDecision(room.game);
  if (acting !== characterId) return;
  const control = room.melyssaControl;
  if (!control || control.melyssaCharacterId !== characterId || control.puppetCharacterId !== puppetId) return;

  // Tutorial rooms only ever accept the one scripted next step - same
  // defense-in-depth principle as handleAction/handleSoulSwapWrath's own
  // tutorial gates (the client UI already fully locks this via
  // tutorialRequiredActionId, so an honest client can never reach here with
  // a mismatched actionId/targetId, but the server shouldn't rely on that
  // alone). step.puppetOf must match the puppet actually being driven -
  // every Mind Control tutorial step is puppetOf-tagged from stage 2
  // onward (see tutorialSequences.js).
  if (isTutorialRoom(room)) {
    const step = currentTutorialStep(room);
    if (!step || step.actor !== 'human' || step.actionId !== actionId || step.puppetOf !== puppetId) return;
    if (step.actionId !== '__mcSelfChoke' && resolveTutorialTarget(room, step) !== (targetId ?? null)) return;
    executeTutorialStep(room, step);
    broadcastGameState(room);
    runBotTurnsIfAny(room);
    return;
  }

  // soulSwapWrath needs its OWN branch here rather than falling through to
  // mindControlOptionsFor below: that function calls usableActionsFor ->
  // ... -> getLegalActions, which explicitly filters out `hidden: true`
  // actions (see zerathys.js - soulSwapWrath is hidden on purpose, since
  // it's never a player-picked button under NORMAL circumstances, only
  // armed programmatically right after soulSwap resolves). That's exactly
  // correct for every other caller of mindControlOptionsFor, but it means
  // soulSwapWrath could never appear in validOptions - every submission of
  // it was being silently rejected by the generic `!optionDef` check
  // below, 100% of the time (confirmed via a live report + a fix-verify
  // test). Mirrors exactly how handleSoulSwapWrath (the non-puppeted
  // version) already validates its own submission: isValidTarget(...,
  // 'soulSwapWrath', ...) directly, never through getLegalActions.
  if (actionId === 'soulSwapWrath') {
    if (!isValidTarget(room.game, puppetId, 'soulSwapWrath', targetId)) return;
    executeActionAsPuppet(room.game, characterId, puppetId, 'soulSwapWrath', targetId);
    room.melyssaControl = null;
    finishMelyssaTurn(room.game, characterId);
    broadcastGameState(room);
    runBotTurnsIfAny(room);
    return;
  }

  // Never trust the client's own option list - re-derive server-side.
  const validOptions = mindControlOptionsFor(room.game, characterId, puppetId);
  const optionDef = validOptions.find((o) => o.actionId === actionId);
  if (!optionDef) return;
  if (optionDef.needsTarget && !optionDef.validTargetIds.includes(targetId)) return;

  let followUp = null; // set when the chosen action needs a stage-3 continuation
  if (actionId === '__mcSelfChoke') {
    executeSelfChoke(room.game, characterId, puppetId);
  } else if (actionId === '__mcJesterBallTake') {
    finishJesterBall(room.game, 'take', undefined);
    // Take doesn't consume the puppet's turn - per spec, Melyssa also
    // puppets the follow-up normal action, same overall Mind Control turn -
    // BUT Take's flat -4 can itself KO the puppet outright. A KO'd
    // character has no real action to offer (getLegalActions has no isKO
    // guard at all - it's normally unreachable territory, since a dead
    // character never gets a turn under normal play; puppeting one into a
    // fatal Take is the one way to reach it), so a follow-up here would
    // show a phantom "choose their action" panel with real buttons for a
    // character already shown KO'd on the board. Skip the follow-up
    // entirely and end Melyssa's turn instead.
    if (!room.game.characters[puppetId].isKO) {
      followUp = { puppetId, options: mindControlOptionsFor(room.game, characterId, puppetId) };
    }
  } else if (actionId === '__mcJesterBallPass') {
    finishJesterBall(room.game, 'pass', targetId);
    // Pass DOES consume the holder's action - Mind Control turn is complete.
  } else {
    executeActionAsPuppet(room.game, characterId, puppetId, actionId, targetId);
    if (actionId === 'soulSwap') {
      // Puppeted Soul Swap's automatic Thunder Wrath follow-up - she picks
      // its target too, same Mind Control turn. Submitted back through
      // THIS same handler (not handleSoulSwapWrath, whose seat-check
      // assumes characterId is the caster - wrong for a puppeted
      // continuation, where the client must keep sending
      // characterId: 'melyssa' to pass the seat-ownership check above).
      const wrathTargets = Object.keys(room.game.characters).filter((tid) => isValidTarget(room.game, puppetId, 'soulSwapWrath', tid));
      followUp = {
        puppetId,
        options: [{ actionId: 'soulSwapWrath', label: 'Thunder Wrath (free, from Soul Swap)', needsTarget: true, special: false, validTargetIds: wrathTargets }],
      };
    }
  }

  if (followUp) {
    broadcastMindControlStage(room, characterId, followUp.puppetId, followUp.options);
    return;
  }

  // Mind Control turn genuinely over.
  room.melyssaControl = null;
  finishMelyssaTurn(room.game, characterId);
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

function handleJesterBallChoice(room, sessionId, { characterId, choice, targetId }) {
  if (room.phase !== 'in-match' || !room.game) return;
  const jb = room.game.jesterBall;
  if (!jb || jb.holderCharacterId !== characterId) return;
  const seat = seatForCharacter(room, characterId);
  if (!seat || seat.playerId !== sessionId) return;
  if (choice === 'pass' && jb.passCount >= 5) return;
  if (choice === 'pass' && !isJesterBallPassTarget(room.game, characterId, targetId)) return;
  finishJesterBall(room.game, choice, targetId);
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

function isJesterBallPassTarget(game, holderId, targetId) {
  const t = game.characters[targetId];
  const holder = game.characters[holderId];
  if (!t || t.isKO || targetId === holderId) return false;
  const isBoingo = targetId === game.jesterBall.thrownByCharacterId;
  // Boingo is a legal Pass target regardless of team (passing to him always
  // heals him and ends the ball, same as the old dedicated Return choice) -
  // exempted from the normal teammate-exclusion below. Passing to any OTHER
  // teammate is still excluded, same as every other targeted action.
  if (t.ownerId === holder.ownerId && !isBoingo) return false;
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
// Ping/pong heartbeat: without this, a connection silently dropped by an
// intermediate proxy/load balancer (Render sits behind one) or a phone
// putting the tab to sleep never fires a 'close' event on the server side -
// the socket just sits there looking alive while actually being dead. That
// left the OTHER players in a room stuck watching a "frozen" bot turn
// forever (the disappeared player's seat never got cleaned up/handed to a
// bot), and the disappeared player's own client never showed "Connection
// lost" until they happened to click something and the send() itself
// failed. ws's own documented isAlive pattern: mark every socket alive on
// each incoming pong, ping everyone on an interval, and terminate() (which
// fires 'close', reusing the existing leaveRoom cleanup) any socket that
// never answered the PREVIOUS ping - gives a dead connection at most one
// full interval before it's detected and cleaned up.
const HEARTBEAT_INTERVAL_MS = 15000;
function startHeartbeat() {
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);
}

wss.on('connection', (ws) => {
  const sessionId = randomUUID();
  sessions.set(sessionId, ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, 'session', { sessionId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, ...payload } = msg;

    if (type === 'create-room') return handleCreateRoom(ws, sessionId, payload);
    if (type === 'create-tutorial-room') return handleCreateTutorialRoom(ws, sessionId, payload);
    if (type === 'join-room') return handleJoinRoom(ws, sessionId, payload);
    if (type === 'reconnect') return handleReconnect(ws, sessionId, payload);
    if (type === 'leave-room') return leaveRoom(sessionId, ws);

    const room = findRoomBySessionId(sessionId);
    if (!room) return;

    switch (type) {
      case 'pick-character': return handlePickCharacter(room, sessionId, payload);
      case 'unpick-character': return handleUnpickCharacter(room, sessionId, payload);
      case 'fill-bot': return handleFillBot(room, sessionId, payload);
      case 'remove-bot': return handleRemoveBot(room, sessionId, payload);
      case 'kick-player': return handleKickPlayer(room, sessionId, payload);
      case 'reorder-seats': return handleReorderSeats(room, sessionId, payload);
      case 'start-match': return handleStartMatch(room, sessionId);
      case 'return-to-lobby': return handleReturnToLobby(room, sessionId);
      case 'abandon-match': return handleAbandonMatch(room, sessionId);
      case 'action': return handleAction(room, sessionId, payload);
      case 'soul-swap-wrath': return handleSoulSwapWrath(room, sessionId, payload);
      case 'mind-control-action': return handleMindControlAction(room, sessionId, payload);
      case 'jester-ball-choice': return handleJesterBallChoice(room, sessionId, payload);
      case 'chat-message': return handleChatMessage(room, sessionId, payload);
      default: return;
    }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
    // A genuine disconnect mid-match, for a seat that CAN be reconnected to
    // (has a reconnectToken - i.e. claimed via handleCreateRoom/
    // handleJoinRoom, not a tutorial seat), gets a 60s grace period instead
    // of leaveRoom's usual immediate-and-permanent bot conversion - see
    // startDisconnectGracePeriod. Every other close (lobby-phase, tutorial
    // rooms, or a seat with no token for some other reason) falls through to
    // the existing leaveRoom behavior unchanged.
    const room = findRoomBySessionId(sessionId);
    const seat = room?.seats.find((s) => s.spectatorId === sessionId);
    if (room && seat && seat.kind === 'human' && room.phase === 'in-match' && seat.reconnectToken) {
      startDisconnectGracePeriod(room, seat, room.ownerId === sessionId);
      return;
    }
    leaveRoom(sessionId);
  });
});

startHeartbeat();

httpServer.listen(PORT, () => {
  console.log(`Soul Clash multiplayer server listening on port ${PORT}`);
});
