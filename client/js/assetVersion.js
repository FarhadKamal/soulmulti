// Cache-busting for static assets (images/audio) - served from a SEPARATE
// static host (GitHub Pages, see ASSET_HOST below), not this game's own
// server, since Render's bandwidth-billed free tier made repeatedly
// serving ~54MB of images/sounds directly expensive (confirmed report,
// 2026-09-04: heavy iterative image-asset work in a single session alone
// pushed past 1GB of a 5GB/month cap). GitHub Pages' bandwidth is free/
// unmetered for a public repo, and already sends permissive CORS
// (Access-Control-Allow-Origin: *) by default, so fetching cross-origin
// from Render's own domain works with no extra server-side config needed.
//
// The asset files themselves now live in a separate repo
// (github.com/FarhadKamal/soulclash-assets), mirroring the exact same
// assets/... folder structure this game's code already expects - so every
// existing v(path) call site (imagePreload.js, portraitFlash.js, sound.js,
// etc.) needed ZERO changes; only this file's own URL construction changed.
const ASSET_HOST = 'https://farhadkamal.github.io/soulclash-assets';

// What a page CAN do about a stale browser-cached asset: force ONE
// PARTICULAR asset's request to be treated as a DIFFERENT cache entry by
// appending a query string that changes for THAT file specifically - pure
// cache-identity trick on the browser's side.
//
// PER-FILE content-hash versioning (confirmed ruling, 2026-09-01) - an
// asset whose content hasn't changed keeps the exact same URL (and stays
// browser-cached) across deploys and Hard Refresh clicks alike, while a
// file that actually changed gets a new URL and a real re-fetch. The
// manifest itself now lives in the assets repo too (asset-manifest.json,
// regenerated via that repo's own build-manifest.js script whenever an
// asset changes, committed and pushed alongside it) rather than being
// computed live by this game's own server, since GitHub Pages is static
// hosting only - there's no live process on that side to hash files
// on-demand the way Render's old buildAssetManifest() did.
let manifest = null; // null until the fetch resolves; then a plain object map
let manifestFetchStarted = false;

// Legacy fallback token (sessionStorage-backed, matches the OLD global
// scheme) - used only in the brief window before the manifest has loaded,
// or for any path the manifest doesn't happen to know about (e.g. a
// filename typo, or an asset added to the assets repo without regenerating
// its manifest - defensive, shouldn't come up in normal operation). Also
// what Hard Refresh still bumps directly (see hardRefresh below) as a
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
  fetch(`${ASSET_HOST}/asset-manifest.json`)
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => {
      if (json && typeof json === 'object') manifest = json;
    })
    .catch(() => {
      // Network hiccup or the endpoint isn't there - manifest just stays
      // null, every v() call keeps using the legacy fallback token for
      // this whole session. Not fatal: worst case is the old "everything
      // shares one token" behavior, never a broken asset URL.
    });
}

// Appends the current cache-busting version to an asset path AND prefixes
// it with the separate asset host - safe to call on every asset URL
// unconditionally. Uses the manifest's own per-file hash once loaded (the
// common case, moments after page load); falls back to the legacy
// session-wide token for the brief pre-load window or for a path the
// manifest doesn't recognize.
export function v(path) {
  ensureManifestFetchStarted();
  const hash = manifest?.[path];
  return `${ASSET_HOST}/${path}?v=${hash ?? getFallbackVersion()}`;
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
