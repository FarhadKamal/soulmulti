import { playUiClick } from './sound.js';

// Browsers block requestFullscreen() from firing without a direct user
// gesture (click/tap) - it can never be triggered automatically on page
// load, only from inside a real click handler like the button below.
export function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {
      // Ignore - browser may still block it, or the API may be
      // unsupported; the button simply won't do anything in that case.
    });
  }
}

// Shared button factory (lobby + battle screens both want this in the same
// top-right spot) - symbol-only (⛶ enter / ⤢ exit) rather than text, per
// request. Swaps automatically on fullscreenchange (registered once, see
// main.js) so it stays correct even if the user exits via Escape rather
// than clicking this same button.
export function renderFullscreenButton() {
  const btn = document.createElement('button');
  btn.className = 'fullscreen-btn';
  btn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  btn.textContent = document.fullscreenElement ? '⤢' : '⛶';
  btn.onclick = () => {
    playUiClick();
    toggleFullscreen();
  };
  return btn;
}
