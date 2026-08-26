import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

import { CHARACTER_IDS } from '../client/js/characters.js';
import { recordMatchResult } from './matchStats.js';
import { createGame } from './engine/state.js';
import {
  getUsableActions, getUsablePuppetActions, executeAction, isValidTarget, isValidMindControlTarget,
  isValidPuppetTarget, markCharacterActed, finalizeAction, executeActionAsPuppet,
  isMelyssaLoneDuel, LONE_DUEL_EXCEPTIONS, recordActionAgainstChronoxIfApplicable,
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
  // Room-level (seatless) watchers - see rooms.js's spectatorIds comment.
  for (const sessionId of room.spectatorIds) {
    const ws = sessions.get(sessionId);
    if (ws) send(ws, type, payload);
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
  for (const sessionId of room.spectatorIds) {
    const ws = sessions.get(sessionId);
    if (ws) send(ws, type, buildPayload(sessionId));
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
  // Sets/Maps don't survive JSON.stringify (a Map serializes to {}, silently
  // dropping every entry) - convert what's left to arrays/plain objects.
  // Kaelis's grudgeCounts (Map<attackerCharacterId, number>) needs this to
  // ever reach the client at all - previously it always broadcast as {},
  // making the per-enemy grudge badge (battleScreen.js) impossible.
  for (const character of Object.values(clone.characters)) {
    if (character.special) {
      for (const [k, v] of Object.entries(character.special)) {
        if (v instanceof Set) character.special[k] = [...v];
        else if (v instanceof Map) character.special[k] = Object.fromEntries(v);
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

// Puppet-aware counterpart to usableActionsFor - a puppeted character's
// real options are allowed to hit ANY other character, including their own
// teammate, not just who they'd normally consider an enemy (requested
// directly: puppeting Blade should be able to make him attack his own
// teammate Tharox). Uses getUsablePuppetActions/isValidPuppetTarget instead
// of getUsableActions/isValidTarget - see those functions' own comments in
// turnEngine.js for why a puppet-only exception, not a change to
// isValidTarget itself (which is load-bearing enemy-only logic for every
// character's OWN normal turn).
function puppetActionsFor(game, puppetId) {
  const puppet = game.characters[puppetId];
  if (!puppet) return [];
  return getUsablePuppetActions(puppet, game).map((a) => ({
    actionId: a.actionId,
    label: a.label,
    needsTarget: a.needsTarget,
    special: !!a.special,
    validTargetIds: a.needsTarget
      ? Object.keys(game.characters).filter((tid) => isValidPuppetTarget(game, puppetId, a.actionId, tid))
      : [],
  }));
}

// Computes the serializable option list for stage 2 of Mind Control (what
// the puppet can be made to do) - reuses puppetActionsFor for the puppet's
// REAL options (never re-derived by hand), then layers in the
// Jester-Ball-holder forced choice and/or Self Choke as needed. Both
// server/index.js's own handlers and the bot flow (via chooseBotMelyssaPuppetAction,
// which calls getUsablePuppetActions directly rather than this function -
// see botPlayer.js) need this exact same option set for legality purposes,
// but only the human-facing path needs it SERIALIZED for broadcast, hence
// this lives here rather than in turnEngine.js.
// Self Choke never routes through isValidPuppetTarget/isValidTarget at all
// (it's needsTarget: false, and the puppet is its own implicit "target"),
// so Chronox's Rewind lockout - which every other action against him is
// checked against in those two functions - was silently never enforced
// against it. Confirmed live: Melyssa could keep forcing a puppeted Chronox
// into Self Choke turn after turn, immune to the very lockout his own
// Rewind had just imposed on that exact (caster, action) pair.
//
// Keyed on melyssaId, NOT puppetId: executeSelfChoke's own
// recordActionAgainstChronoxIfApplicable call (below) deliberately records
// MELYSSA as the caster (matching Self Choke's real actor/victim
// attribution - see executeSelfChoke's own comment), so that's who Rewind's
// lockedActionCasterId actually names afterward, confirmed by the live log
// itself ("Chronox used Rewind - undid Melyssa's Self Choke!"). Checking
// against puppetId here would never match.
function isSelfChokeLocked(game, melyssaId, puppetId) {
  if (puppetId !== 'chronox') return false;
  const chronoxChar = game.characters.chronox;
  return !!chronoxChar && chronoxChar.special.lockedActionCasterId === melyssaId
    && chronoxChar.special.lockedActionId === 'selfChoke';
}

function mindControlOptionsFor(game, melyssaId, puppetId) {
  const puppet = game.characters[puppetId];
  const isEnemyPuppet = puppet.ownerId !== game.characters[melyssaId].ownerId;
  const selfChokeLocked = isSelfChokeLocked(game, melyssaId, puppetId);

  const jb = game.jesterBall;
  if (jb && jb.holderCharacterId === puppetId) {
    const passTargets = Object.keys(game.characters).filter((tid) => isJesterBallPassTarget(game, puppetId, tid));
    const jbOptions = [
      { actionId: '__mcJesterBallTake', label: 'Take the Jester Ball (-4 hearts)', needsTarget: false, special: false, validTargetIds: [] },
    ];
    if (jb.passCount < 5) {
      jbOptions.push({ actionId: '__mcJesterBallPass', label: 'Pass the Jester Ball', needsTarget: true, special: false, validTargetIds: passTargets });
    }
    return isEnemyPuppet && !selfChokeLocked ? [...jbOptions, selfChokeOption()] : jbOptions;
  }

  // Lone-duel restriction only applies to an ENEMY puppet (an ally puppet
  // was never offered Self Choke at all, so there's nothing to restrict
  // TO) and never to Zerathys (see LONE_DUEL_EXCEPTIONS above).
  if (isEnemyPuppet && !LONE_DUEL_EXCEPTIONS.has(puppetId) && isMelyssaLoneDuel(game, melyssaId)) {
    // Note: if Self Choke is locked in this exact stalemate scenario, there
    // is genuinely no legal option left for this puppet - the caller (both
    // the human and bot paths, via getUsablePuppetActions/hasAnyValidTarget)
    // is expected to fall back to skip logic same as any other "no usable
    // action" case, not something this function needs to special-case.
    return selfChokeLocked ? [] : [selfChokeOption()];
  }

  const realOptions = puppetActionsFor(game, puppetId);
  if (!isEnemyPuppet || selfChokeLocked) return realOptions;
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
  // Chronox's Rewind needs to see this too, if he's ever the puppet forced
  // into it - Self Choke doesn't route through executeAction (it calls
  // applyDamage directly), so it needs the same recording hook called
  // explicitly here.
  recordActionAgainstChronoxIfApplicable(game, melyssaId, 'selfChoke', puppetId);
  const log = [];
  const result = applyDamage(game, log, {
    sourceCharacterId: melyssaId,
    targetCharacterId: puppetId,
    // Buffed 1->2: unlike a puppeted real action (now only a 50% chance to
    // actually resolve, see executeActionAsPuppet), Self Choke stays fully
    // guaranteed every time - the tradeoff is now "risk a real attack for
    // a coin-flip, or take a bigger guaranteed 2" rather than Self Choke
    // being the strictly worse fallback it was at 1 damage.
    amount: 2,
    ignoresShield: true,
  });
  log.push({ type: 'attack', characterId: melyssaId, actionId: 'selfChoke', targetId: puppetId, ...result });
  finalizeAction(game, log, result, melyssaId, 'selfChoke', puppetId);
  return result;
}

// Marks a Mind-Control-driven turn as truly, fully over - used at both
// points that's the case: handleMindControlAction's no-follow-up branch
// and finishBotMindControlTurn (bot equivalent). Replaces the bare
// markCharacterActed(..., melyssaId) call each of those sites would
// otherwise need, since Melyssa's turn also needs her own
// special.controlling flag cleared (ends the held selection portrait).
function finishMelyssaTurn(game, melyssaId) {
  markCharacterActed(game, melyssaId);
  game.characters[melyssaId].special.controlling = false;
  game.characters[melyssaId].special.puppetCharacterId = null;
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
    // Guard BEFORE flipping room.phase - this whole branch re-enters on
    // every subsequent broadcastGameState call while the match stays
    // game-over (e.g. the bots4 restart's own broadcastGameState re-call),
    // so without this check recordMatchResult would fire repeatedly for
    // the same finished match instead of exactly once at the real
    // transition.
    if (room.phase !== 'finished') recordMatchResult(room.game, room.roomType);
    room.phase = 'finished';
    clearTurnTimer(room);
    // 'bots4' has no human to click Return to Lobby/Start Match - the
    // spectacle keeps going on its own. Scheduled after a delay so the
    // win screen actually has a moment on screen before the board resets;
    // guarded by a code match (not just room identity) in case this
    // exact room got deleted (spectator disconnected, see its own
    // handling) and a NEW room later reused the same code slot.
    if (room.roomType === 'bots4') {
      const code = room.code;
      setTimeout(() => {
        const stillHere = getRoom(code);
        if (stillHere !== room) return;
        startFreshBotShowMatch(room);
        broadcastLobby(room);
        broadcastGameState(room);
        runBotTurnsIfAny(room);
      }, BOT_SHOW_RESTART_DELAY_MS);
    }
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
// for the rest of the match (see multiplayer design notes). ----
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

  const character = room.game.characters[acting];
  const isBallHolder = room.game.jesterBall && room.game.jesterBall.holderCharacterId === acting;
  if (isBallHolder) {
    const move = chooseBotJesterBallMove(character, room.game);
    finishJesterBall(room.game, move.choice, move.targetId);
    // Draxus's Deathless Fury bonus turn, forfeited: resolving the ball -
    // Take OR Pass, either one - consumes his ENTIRE bonus turn per spec.
    // Take normally does NOT call markCharacterActed (see finishJesterBall,
    // gameFlow.js), letting the holder act again that same turn - that's
    // exactly the behavior overridden here, ONLY while his bonus turn is
    // active, so it never changes ball behavior for his own normal turns
    // or anyone else's.
    if (character.id === 'draxus' && character.special.bonusActionsRemaining > 0) {
      character.special.bonusActionsRemaining = 0;
      markCharacterActed(room.game, acting);
    }
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
      // Snapshot BEFORE executing: if this hit lands on Draxus while his
      // Deathless Fury window is active, broadcastGameState's internal
      // settleToNextDecision (called below) can silently fast-forward
      // straight through his own onTurnStart in this SAME tick when it's
      // his turn next - collapsing "the hit landed" and "the window ends,
      // 3 strikes granted" into one broadcast. The match log then shows
      // them as two separate lines, but the player only ever saw ONE
      // combined snapshot where the portrait had already flipped to
      // injured.jpg - reported as "the portrait changes one log line too
      // early" even though the state itself was technically already
      // correct for that (later) instant. Insert one extra paced beat here
      // so the hit is genuinely visible on its own first.
      const draxus = room.game.characters['draxus'];
      const hitDraxusMidWindow = move.targetId === 'draxus'
        && draxus && !draxus.isKO && draxus.special.deathproofActive;

      executeAction(room.game, acting, move.actionId, move.targetId);
      if (move.actionId === 'soulSwap') {
        const wrathTarget = chooseSoulSwapWrathTarget(character, room.game);
        if (wrathTarget) executeAction(room.game, acting, 'soulSwapWrath', wrathTarget);
      }

      if (hitDraxusMidWindow && draxus.special.deathproofActive) {
        // Still active right after the hit (the floor caught it, as
        // expected) - broadcast this exact moment RAW, without letting
        // settleToNextDecision advance any further, then pause before the
        // normal settling broadcast (which is where his onTurnStart may
        // fire) continues as usual. Must still mark the attacker acted
        // here (normally done below, at the bottom of this else-branch) -
        // skipping it left the SAME character acting again indefinitely,
        // since settleToNextDecision would keep returning them as not yet
        // having acted this round (live-reported regression: "Chronox
        // keeps hitting me").
        markCharacterActed(room.game, acting);
        broadcastRoom(room, 'game-state', {
          game: sanitizeGameForBroadcast(room.game),
          actingCharacterId: acting,
          usableActions: [],
          turnDeadline: null,
          humanCount: room.seats.filter((s) => s.kind === 'human').length,
        });
        setTimeout(() => stepBotTurn(room), BOT_ACTION_DELAY_MS);
        return;
      }
    }
    // Draxus's Deathless Fury bonus turn: his own onTurnStart already set
    // bonusActionsRemaining to 3 (draxus.js) - decrement instead of
    // marking him acted so settleToNextDecision keeps returning him as the
    // acting character. stepBotTurn's own post-action re-check just below
    // (line ~640) already naturally schedules another tick when this
    // happens - no new bot-pacing function needed for strikes 2 and 3.
    if (character.id === 'draxus' && character.special.bonusActionsRemaining > 0) {
      character.special.bonusActionsRemaining -= 1;
    }
    if (!(character.id === 'draxus' && character.special.bonusActionsRemaining > 0)) {
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
  // excludeOwnerId=Melyssa's own side - see chooseSoulSwapWrathTarget's own
  // comment for why this follow-up needs it and a normal (non-puppeted)
  // Soul Swap doesn't.
  const wrathTarget = decision.actionId === 'soulSwap'
    ? chooseSoulSwapWrathTarget(puppet, room.game, room.game.characters[melyssaId].ownerId)
    : null;
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

// Delay before a 'bots4' room's next match auto-starts after the previous
// one ends - long enough for a viewer to actually register the win screen
// (matches BOT_ACTION_DELAY_MS's own "give a human a beat to read this"
// reasoning) AND to let the winner's victory voice line finish playing
// (client-side, playVictoryVoice - see main.js's game-over handling)
// before the board resets out from under them. Must also clear the
// client's own bots4-specific freeze+victory reveal (2.5s + 6s = 8.5s,
// see main.js's startGameOverSequence) before the banner even appears, on
// top of actual time to read it - this delay is measured from when
// game-over first arrives, not from when the banner shows. Bumped from an
// initial 6s (then 12s), which cut the reveal/voice lines short and reset
// the board almost as soon as the banner appeared. Reported directly: the
// auto-looping spectacle cut to the win screen and reset too fast to enjoy.
const BOT_SHOW_RESTART_DELAY_MS = 20000;

// "Watch 4 bots play" - a pure spectacle room with no human seat at all.
// The connecting session is added to room.spectatorIds (never a seat - see
// that field's own comment in rooms.js) so it keeps receiving every
// broadcast without owning/controlling anything. All 4 seats are
// immediately bot-filled with distinct random characters (fillSeatWithBot
// already guarantees no repeats, via availableCharacterIds) and the match
// starts right away, exactly like handleStartMatch's own tail. See
// broadcastGameState's 'bots4' branch for the auto-restart-on-game-over loop.
function handleCreateBotShowRoom(ws, sessionId, { name }) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return send(ws, 'error', { message: 'A name is required.' });
  const room = createRoom('bots4');
  room.spectatorIds.add(sessionId);
  startFreshBotShowMatch(room);
  send(ws, 'room-created', { code: room.code });
  broadcastLobby(room);
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

// Same spectacle room as handleCreateBotShowRoom above, but the viewer picks
// which 4 characters face off instead of getting a fully random lineup.
// characterIds must be exactly 4 distinct, valid ids - any fewer/invalid
// picks and the client should have disabled the button, so this is a
// defensive reject rather than a partial-fill (silently substituting random
// picks for an incomplete selection would surprise someone who thought they
// picked all 4 themselves). Stored on room.pinnedCharacterIds so every
// auto-restart (broadcastGameState's 'bots4' branch) reseats the SAME 4
// characters again, not a fresh random draw each time.
function handleCreateBotShowRoomCustom(ws, sessionId, { name, characterIds }) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return send(ws, 'error', { message: 'A name is required.' });
  if (!Array.isArray(characterIds) || characterIds.length !== 4) {
    return send(ws, 'error', { message: 'Pick exactly 4 characters.' });
  }
  const distinct = new Set(characterIds);
  if (distinct.size !== 4 || characterIds.some((id) => !CHARACTER_IDS.includes(id))) {
    return send(ws, 'error', { message: 'Pick 4 distinct, valid characters.' });
  }
  const room = createRoom('bots4');
  room.pinnedCharacterIds = [...characterIds];
  room.spectatorIds.add(sessionId);
  startFreshBotShowMatch(room);
  send(ws, 'room-created', { code: room.code });
  broadcastLobby(room);
  broadcastGameState(room);
  runBotTurnsIfAny(room);
}

// Resets all 4 seats to freshly bot-filled and starts a brand new game -
// shared by the initial creation above and the auto-restart loop in
// broadcastGameState, so both paths produce an identical fresh match. When
// room.pinnedCharacterIds is set (custom-pick bot-show, see
// handleCreateBotShowRoomCustom), seats the SAME 4 characters again every
// time instead of drawing a fresh random distinct set - otherwise identical
// to the random flow.
function startFreshBotShowMatch(room) {
  for (const seat of room.seats) {
    seat.kind = 'empty';
    seat.characterIds = [];
    seat.name = null;
  }
  if (room.pinnedCharacterIds) {
    room.seats.forEach((seat, i) => {
      seat.kind = 'bot';
      seat.name = 'Bot';
      seat.characterIds = [room.pinnedCharacterIds[i]];
    });
  } else {
    for (const seat of room.seats) fillSeatWithBot(room, seat);
  }
  const playerPicks = room.seats.map((s) => ({
    id: `bot-${s.index}`,
    name: s.name,
    characterIds: s.characterIds,
    isPC: true,
  }));
  room.game = createGame(room.roomType, playerPicks);
  room.phase = 'in-match';
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

// Same as handleFillBot, but the owner picks the bot's character themselves
// instead of getting a random draw.
function handleFillBotWithCharacter(room, sessionId, { seatIndex, characterId }) {
  if (sessionId !== room.ownerId) return;
  const seat = room.seats[seatIndex];
  if (!seat || seat.kind !== 'empty') return;
  if (!CHARACTER_IDS.includes(characterId)) return;
  if (!availableCharacterIds(room).includes(characterId)) return; // taken elsewhere
  seat.kind = 'bot';
  seat.name = seat.name || 'Bot';
  seat.characterIds.push(characterId);
  fillSeatWithBot(room, seat); // tops up any remaining picksPerSeat slots randomly
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
  // A 'bots4' room's viewer never owns a seat (see rooms.js's
  // spectatorIds) - once they leave/disconnect, nothing is watching a
  // bot-only spectacle anymore, so the whole room is torn down immediately
  // rather than left running forever for no one (the same tradeoff every
  // other "all humans leave" case already makes, just via a different check
  // since there's no human seat here to notice leaving).
  if (room.spectatorIds.has(sessionId)) {
    room.spectatorIds.delete(sessionId);
    if (ws) send(ws, 'left-room', {});
    deleteRoom(room.code);
    return;
  }
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
  // with, since a reconnectable seat's close handler diverts to the grace
  // period instead of ever calling leaveRoom directly.
  permanentlyConvertSeatToBot(room, seat, room.ownerId === sessionId);
}

// Starts a 60s grace period for a seat whose connection just genuinely
// dropped mid-match (heartbeat-detected dead socket, or a real close event) -
// called only for seats that have a reconnectToken (i.e. claimed via
// handleCreateRoom/handleJoinRoom) and only while
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
  if (actionId === 'mindControl') {
    const result = executeAction(room.game, characterId, actionId, targetId);
    const puppetId = result.puppetCharacterId;
    const puppetOptions = mindControlOptionsFor(room.game, characterId, puppetId);
    broadcastMindControlStage(room, characterId, puppetId, puppetOptions);
    return;
  }

  // Snapshot BEFORE executing: same collapse risk as stepBotTurn's own
  // guard below - if this action hits Draxus while his Deathless Fury
  // window is active, and it happens to become his own turn next,
  // broadcastGameState's internal settleToNextDecision would fast-forward
  // through his onTurnStart in this SAME broadcast, silently ending the
  // window and granting his bonus strikes before the client ever saw the
  // hit landing on its own. See the matching comment in stepBotTurn for
  // the full reasoning.
  const draxusBeforeAction = room.game.characters['draxus'];
  const hitDraxusMidWindow = targetId === 'draxus'
    && draxusBeforeAction && !draxusBeforeAction.isKO && draxusBeforeAction.special.deathproofActive;

  executeAction(room.game, characterId, actionId, targetId);

  if (hitDraxusMidWindow && draxusBeforeAction.special.deathproofActive && actionId !== 'soulSwap') {
    // Still active right after the hit (the floor caught it) - broadcast
    // this exact moment raw, without letting settleToNextDecision advance
    // any further, then let the normal flow (including any bot turns)
    // continue after a beat.
    broadcastRoom(room, 'game-state', {
      game: sanitizeGameForBroadcast(room.game),
      actingCharacterId: characterId,
      usableActions: [],
      turnDeadline: null,
      humanCount: room.seats.filter((s) => s.kind === 'human').length,
    });
    setTimeout(() => {
      markCharacterActed(room.game, characterId);
      broadcastGameState(room);
      runBotTurnsIfAny(room);
    }, BOT_ACTION_DELAY_MS);
    return;
  }

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
  // Draxus's Deathless Fury bonus turn: his own onTurnStart already set
  // bonusActionsRemaining to 3 (see draxus.js) - decrement it here instead
  // of marking him acted, so settleToNextDecision keeps returning him as
  // the acting character for strikes 2 and 3, reusing this exact same
  // normal 'action' path each time (no new message type/handler needed).
  const actedCharacter = room.game.characters[characterId];
  if (actedCharacter.id === 'draxus' && actedCharacter.special.bonusActionsRemaining > 0) {
    actedCharacter.special.bonusActionsRemaining -= 1;
    if (actedCharacter.special.bonusActionsRemaining > 0) {
      // More strikes owed this turn - re-arm the timer for the next one
      // (same re-arm precedent as Soul Swap's own follow-up stage above)
      // and broadcast normally WITHOUT marking him acted.
      armTurnTimer(room, characterId);
      broadcastGameState(room);
      runBotTurnsIfAny(room);
      return;
    }
    // Bonus sequence genuinely over (3rd strike just resolved) - fall
    // through below to end his turn for real.
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
    // isValidPuppetTarget (ally-allowed), not isValidTarget - a puppeted
    // Wrath follow-up gets the same "can hit the puppet's own teammate"
    // treatment as every other puppeted real action, see puppetActionsFor.
    if (!isValidPuppetTarget(room.game, puppetId, 'soulSwapWrath', targetId)) return;
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
      const wrathTargets = Object.keys(room.game.characters).filter((tid) => isValidPuppetTarget(room.game, puppetId, 'soulSwapWrath', tid));
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
  // Draxus's Deathless Fury bonus turn, forfeited: resolving the ball -
  // Take OR Pass, either one - consumes his ENTIRE bonus turn per spec.
  // Take normally does NOT call markCharacterActed (see finishJesterBall,
  // gameFlow.js), letting the holder act again that same turn - that's
  // exactly the behavior overridden here, ONLY while his bonus turn is
  // active, so it never changes ball behavior for his own normal turns or
  // anyone else's.
  const character = room.game.characters[characterId];
  if (character.id === 'draxus' && character.special.bonusActionsRemaining > 0) {
    character.special.bonusActionsRemaining = 0;
    markCharacterActed(room.game, characterId);
  }
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
    if (type === 'create-bot-show-room') return handleCreateBotShowRoom(ws, sessionId, payload);
    if (type === 'create-bot-show-room-custom') return handleCreateBotShowRoomCustom(ws, sessionId, payload);
    if (type === 'join-room') return handleJoinRoom(ws, sessionId, payload);
    if (type === 'reconnect') return handleReconnect(ws, sessionId, payload);
    if (type === 'leave-room') return leaveRoom(sessionId, ws);

    const room = findRoomBySessionId(sessionId);
    if (!room) return;

    switch (type) {
      case 'pick-character': return handlePickCharacter(room, sessionId, payload);
      case 'unpick-character': return handleUnpickCharacter(room, sessionId, payload);
      case 'fill-bot': return handleFillBot(room, sessionId, payload);
      case 'fill-bot-with-character': return handleFillBotWithCharacter(room, sessionId, payload);
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
    // handleJoinRoom), gets a 60s grace period instead of leaveRoom's usual
    // immediate-and-permanent bot conversion - see
    // startDisconnectGracePeriod. Every other close (lobby-phase rooms, or a
    // seat with no token for some other reason) falls through to the
    // existing leaveRoom behavior unchanged.
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
