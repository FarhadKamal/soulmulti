// Thin WebSocket wrapper: one persistent connection for the whole tab
// session, dispatched to whichever listener the current screen registered.
// Kept deliberately dumb - no reconnect/retry logic yet (matches the
// server's "leaving = permanent bot takeover" design; there's nothing to
// reconnect back into once a seat's been handed to a bot).

let ws = null;
let listener = null;
let sessionId = null;
let queuedBeforeOpen = [];

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
  ws.addEventListener('open', () => {
    for (const msg of queuedBeforeOpen) ws.send(JSON.stringify(msg));
    queuedBeforeOpen = [];
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'session') sessionId = msg.sessionId;
    if (listener) listener(msg);
  });
  ws.addEventListener('close', () => {
    if (listener) listener({ type: 'connection-closed' });
  });
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
