// Thin WebSocket wrapper: one persistent connection for the whole tab
// session, dispatched to whichever listener the current screen registered.
// Kept deliberately dumb - no reconnect/retry logic yet (matches the
// server's "leaving = permanent bot takeover" design; there's nothing to
// reconnect back into once a seat's been handed to a bot).

let ws = null;
let listener = null;
let sessionId = null;
let queuedBeforeOpen = [];

// Same-origin in production (client and server served together), but
// during local dev the client is opened directly as a file/static server
// while the game server runs separately - override via ?server= query
// param or fall back to localhost.
function resolveServerUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('server');
  if (override) return override;
  // Local dev: the client's static file server (e.g. dev_server.py on
  // :8765) and the game server (:3001) are always two separate processes,
  // never the same origin - file:// and localhost/127.0.0.1 both fall back
  // to the game server's default port rather than trying same-origin.
  const { protocol, hostname } = window.location;
  if (protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'ws://localhost:3001';
  }
  const proto = protocol === 'https:' ? 'wss:' : 'ws:';
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
