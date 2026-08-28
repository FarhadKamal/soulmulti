// Thin WebSocket wrapper: one persistent connection for the whole tab
// session, dispatched to whichever listener the current screen registered.
// No auto-retry-without-reload logic, and no reconnect-token persistence
// either (confirmed ruling: nothing is saved client-side at all - a
// disconnect or refresh just drops the session; getting back into a room
// is always the generic "join by code as a Guest, then claim an open/bot
// seat" flow, same as anyone else joining fresh). It also actively detects
// a silently-dead connection rather than
// waiting indefinitely on the browser's own 'close' event, which in
// practice could take minutes (or never fire at all) for a connection
// dropped by an intermediate proxy/load balancer or a phone backgrounding
// the tab. Reported directly: matches looked "frozen" mid bot-turn with no
// error shown, and clicking Exit was the first time anything revealed the
// connection had already died - the browser was still reporting the socket
// as open the whole time.
let ws = null;
let listener = null;
let sessionId = null;
let queuedBeforeOpen = [];
let lastMessageAt = 0;
let staleCheckInterval = null;

// Deliberately can't be tied to the server's 15s ping interval
// (HEARTBEAT_INTERVAL_MS in index.js) - raw WebSocket ping/pong control
// frames are handled transparently at the browser/protocol level and
// never reach this file's 'message' listener, so this can only measure
// gaps between real application messages (game-state, chat, lobby-update,
// etc.). Those can legitimately go quiet for a while during entirely
// normal play - a human's own 30s turn timer with no action yet, or
// sitting idle on the entry screen typing a name before creating/joining
// a room. 90s is comfortably above the longest normal legitimate gap
// (the 30s turn timer plus real margin) while still catching a truly dead
// connection well before it becomes a multi-minute "why is this frozen"
// experience.
const STALE_THRESHOLD_MS = 90000;
const STALE_CHECK_INTERVAL_MS = 15000;

// In production (Render, or any deploy where server/index.js serves the
// client's own static files - see serveStaticFile there), the page is
// already loaded from the SAME origin the WebSocket server listens on, so
// same-origin is correct and required (Render assigns an arbitrary PORT
// env var - there is no fixed port to hardcode). During local dev,
// dev_server.py serves the client separately on its own fixed :8765 while
// index.js listens on :3001 - two genuinely different processes/ports on
// purpose, so THAT specific case (port 8765, or no server-served page at
// all i.e. file://) still needs the :3001 override. Override via ?server=
// query param for anything else (e.g. testing against a different
// deployment). Previously this always appended ':3001' unconditionally,
// which broke same-origin production deploys where the server's real port
// is whatever Render assigned, not 3001.
function resolveServerUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('server');
  if (override) return override;
  const { protocol, hostname, port } = window.location;
  const proto = protocol === 'https:' ? 'wss:' : 'ws:';
  if (protocol === 'file:' || port === '8765') {
    const host = protocol === 'file:' ? 'localhost' : hostname;
    return `${proto}//${host}:3001`;
  }
  return `${proto}//${window.location.host}`;
}

export function connect() {
  ws = new WebSocket(resolveServerUrl());
  lastMessageAt = Date.now();
  ws.addEventListener('open', () => {
    lastMessageAt = Date.now();
    for (const msg of queuedBeforeOpen) ws.send(JSON.stringify(msg));
    queuedBeforeOpen = [];
  });
  ws.addEventListener('message', (event) => {
    lastMessageAt = Date.now();
    const msg = JSON.parse(event.data);
    if (msg.type === 'session') {
      sessionId = msg.sessionId;
    }
    if (listener) listener(msg);
  });
  ws.addEventListener('close', () => {
    stopStaleCheck();
    if (listener) listener({ type: 'connection-closed' });
  });
  startStaleCheck();
}

// Proactively closes the socket (rather than waiting on the browser's own
// TCP-level detection, which can take minutes or never trigger for some
// dropped-connection scenarios) once too long has passed since the last
// message of ANY kind arrived - see STALE_THRESHOLD_MS above. Calling
// ws.close() here fires the normal 'close' listener above, reusing the
// exact same connection-closed reporting path as a real close - the rest
// of the app doesn't need to know this was a proactive timeout rather
// than a genuine socket-level close event.
function startStaleCheck() {
  stopStaleCheck();
  staleCheckInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastMessageAt > STALE_THRESHOLD_MS) {
      ws.close();
    }
  }, STALE_CHECK_INTERVAL_MS);
}

function stopStaleCheck() {
  if (staleCheckInterval) {
    clearInterval(staleCheckInterval);
    staleCheckInterval = null;
  }
}

export function onMessage(fn) {
  listener = fn;
}

export function send(type, payload = {}) {
  const msg = { type, ...payload };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    queuedBeforeOpen.push(msg);
  }
}

export function getSessionId() {
  return sessionId;
}
