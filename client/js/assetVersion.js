// Cache-busting for static assets (images/audio), which are served with a
// long-lived, immutable Cache-Control header (see server/index.js's
// serveStaticFile) - correct for normal play (nothing has to re-fetch on
// every reload), but it means the browser's own HTTP disk cache is the one
// thing NO amount of in-page JavaScript can force-clear once it's holding
// a stale copy under an unchanged filename (confirmed directly: this app
// has no Service Worker/Cache Storage API in use at all, so there's
// nothing for the Cache API to clear either - the browser's normal disk
// cache is a real security boundary, not a gap in this app).
//
// What a page CAN do: force every asset request to be treated as a
// DIFFERENT cache entry by appending a query string that changes - the
// server ignores query strings entirely (see serveStaticFile's urlPath
// parsing, which strips them before resolving a file), so this is purely
// a cache-identity trick, not a real request difference server-side.
//
// The version token lives in sessionStorage, not module state, so it
// survives the actual page reload the "Hard Refresh" button triggers -
// bumping it right before reload() means every asset URL built AFTER that
// reload (on the fresh page load) carries the new token, forcing fresh
// fetches for that whole session even though the underlying files and
// their real paths never changed.
const STORAGE_KEY = 'soulclash-asset-version';

function getVersion() {
  return sessionStorage.getItem(STORAGE_KEY) || '0';
}

// Appends the current cache-busting version to an asset path. Safe to
// call on every asset URL unconditionally - during normal play (no hard
// refresh ever triggered) the version stays '0' forever, so this is a
// no-op query string that doesn't change caching behavior at all.
export function v(path) {
  return `${path}?v=${getVersion()}`;
}

// Bumps the version token and reloads the page - called from the "Hard
// Refresh" button (see lobbyScreen.js). Every asset URL built by the
// fresh page load afterward (imagePreload.js, audioPreload.js, sound.js,
// voice.js, battleScreen.js's portrait.src assignments, etc. - anywhere
// that wraps its path with v() above) will carry the new token.
export function hardRefresh() {
  sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
  window.location.reload();
}
