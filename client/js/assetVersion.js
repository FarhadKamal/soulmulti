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
// What a page CAN do: force ONE PARTICULAR asset's request to be treated
// as a DIFFERENT cache entry by appending a query string that changes for
// THAT file specifically - the server ignores query strings entirely when
// resolving which file to read (see serveStaticFile's urlPath parsing,
// which strips them before resolving a file), so this is purely a
// cache-identity trick on the browser's side, not a real request
// difference server-side.
//
// PER-FILE content-hash versioning (confirmed ruling, 2026-09-01) -
// replaces an earlier design that stamped every asset with the SAME
// session-wide timestamp on Hard Refresh, forcing a full re-download of
// the entire ~53MB asset set (332 files) every single click even though
// almost none of it had actually changed. Root cause reported directly:
// "if user already have everything their client pc memory... supposed
// only new/updated asset will download. why full?" - a fair expectation
// the old single-shared-token design couldn't meet.
//
// The server computes a content hash for every asset file ONCE at boot
// (server/index.js's buildAssetManifest - hashes actual file bytes, not
// mtime, so it's correct regardless of how the deploy process handles
// file timestamps) and serves it as a flat { 'assets/x/y.jpg': 'abc123' }
// map at GET /asset-manifest.json. This module fetches that manifest once
// on page load; v(path) then appends THAT FILE'S OWN hash as its query
// string - an asset whose content hasn't changed keeps the exact same URL
// (and stays browser-cached) across deploys and Hard Refresh clicks alike,
// while a file that actually changed gets a new URL and a real re-fetch.
let manifest = null; // null until the fetch resolves; then a plain object map
let manifestFetchStarted = false;

// Legacy fallback token (sessionStorage-backed, matches the OLD global
// scheme) - used only in the brief window before the manifest has loaded,
// or for any path the manifest doesn't happen to know about (e.g. a
// filename typo, or an asset added to disk after the manifest was built
// without a redeploy - defensive, shouldn't come up in normal operation).
// Also what Hard Refresh still bumps directly (see hardRefresh below) as a
// last-resort "force everything" escape hatch, though normal per-file
// hashing should make reaching for that rarely necessary now.
const FALLBACK_STORAGE_KEY = 'soulclash-asset-version';

function getFallbackVersion() {
  return sessionStorage.getItem(FALLBACK_STORAGE_KEY) || '0';
}

// Fire-and-forget, started the first time v() is ever called (effectively
// immediately - imagePreload.js/audioPreload.js call it right at page
// load). No await anywhere in this app's startup path (confirmed
// deliberate - see main.js's own fire-and-forget preload comments), so
// this races the very first few v() calls; they fall back to the legacy
// token for that brief window (typically well under 100ms) rather than
// blocking page startup on the fetch.
function ensureManifestFetchStarted() {
  if (manifestFetchStarted) return;
  manifestFetchStarted = true;
  fetch('/asset-manifest.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => {
      if (json && typeof json === 'object') manifest = json;
    })
    .catch(() => {
      // Network hiccup or the endpoint isn't there (e.g. an older deployed
      // server mid-rollout) - manifest just stays null, every v() call
      // keeps using the legacy fallback token for this whole session. Not
      // fatal: worst case is today's old "everything shares one token"
      // behavior, never a broken asset URL.
    });
}

// Appends the current cache-busting version to an asset path. Safe to call
// on every asset URL unconditionally. Uses the manifest's own per-file
// hash once loaded (the common case, moments after page load); falls back
// to the legacy session-wide token for the brief pre-load window or for a
// path the manifest doesn't recognize.
export function v(path) {
  ensureManifestFetchStarted();
  const hash = manifest?.[path];
  return `${path}?v=${hash ?? getFallbackVersion()}`;
}

// Bumps the legacy fallback token and reloads the page - called from the
// "Hard Refresh" button (see lobbyScreen.js). With per-file manifest
// hashing in place, this is now mostly a last-resort escape hatch (e.g.
// the manifest endpoint itself failed to load, or a very stale cached copy
// somehow predates any hash it recognizes) rather than the primary fix
// path - normal deploys already give changed files a new hash-based URL
// automatically, with no button needed and no unchanged file ever
// re-fetched. Still forces a fresh manifest fetch on the reload too, since
// manifestFetchStarted/manifest are page-load-scoped module state that
// resets naturally on any reload.
export function hardRefresh() {
  sessionStorage.setItem(FALLBACK_STORAGE_KEY, String(Date.now()));
  window.location.reload();
}
