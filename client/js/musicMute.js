import { playUiClick, isMusicMuted, toggleMusicMuted } from './sound.js';

// Shared button factory (lobby + battle screens both want this in the same
// top-right spot as the fullscreen button) - same pattern as
// fullscreen.js's renderFullscreenButton. Music-only mute, deliberately
// separate from sound effects/voice lines (see sound.js's own comment).
// No external event listener needed (unlike fullscreen, which can also
// change via Escape outside our own button) - this button is the only way
// the mute state ever changes, so re-rendering its own icon inside its own
// click handler is enough.
export function renderMusicMuteButton() {
  const btn = document.createElement('button');
  btn.className = 'music-mute-btn';
  const update = () => {
    const muted = isMusicMuted();
    btn.title = muted ? 'Unmute music' : 'Mute music';
    btn.textContent = muted ? '🔇' : '🔊';
  };
  update();
  btn.onclick = () => {
    playUiClick();
    toggleMusicMuted();
    update();
  };
  return btn;
}
