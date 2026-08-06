import { send } from './net.js';

// Shared chat panel used by both the lobby and battle screens - messages
// live only in this module's in-memory array for the current tab session
// (no persistence, matches the server's no-history relay). Kept to short
// callouts only, not a scrollback log - only the most recent MAX_VISIBLE
// messages are ever kept at all (older ones are dropped, not just
// scrolled past), matching the server's 60-char per-message cap.
const MAX_VISIBLE = 10;
const messages = [];

// The battle/lobby screens both do a full DOM teardown+rebuild on every
// server broadcast (root.innerHTML = '', then re-render everything) -
// during someone else's turn, bot moves broadcast every few seconds (see
// BOT_ACTION_DELAY_MS in the server), which was recreating this panel's
// <input> from scratch each time. An earlier fix tried to paper over that
// by persisting draftText/focus state and restoring them onto a BRAND NEW
// <input> node after every rebuild - inherently racy against the user's
// own keystrokes landing in between rebuilds, which read as chat being
// unreliable specifically during opponent turns (the only time broadcasts
// arrive automatically; your own turn waits on you, so nothing ever
// interrupts typing then).
//
// The real fix: this module builds its own <input>/<button>/message-list
// ONCE, the moment this file first loads, and every call to
// renderChatPanel() re-appends that SAME persistent node (instead of
// creating a fresh tree) - root.innerHTML = '' still DETACHES it from the
// document each time (that's unavoidable given how battleScreen.js/
// lobbyScreen.js rebuild), which still blurs the input and drops its
// draft value in some browsers, but re-appending the SAME real node here
// (not a fresh one) means there's no more races to fight: the value is
// simply still there on the node, and just needs its focus restored - one
// synchronous, always-correct read of "was this focused a moment ago" via
// wasFocused, not a value/caret round-trip through module state.
let wasFocused = false;
const panel = document.createElement('div');
panel.className = 'chat-panel';

const title = document.createElement('div');
title.className = 'chat-title';
title.textContent = 'Chat';
panel.appendChild(title);

const list = document.createElement('div');
list.className = 'chat-messages';
panel.appendChild(list);

const form = document.createElement('div');
form.className = 'chat-form';
const input = document.createElement('input');
input.type = 'text';
input.maxLength = 60;
input.placeholder = 'Type a message...';
input.addEventListener('focus', () => { wasFocused = true; });
input.addEventListener('blur', () => { wasFocused = false; });
const sendBtn = document.createElement('button');
sendBtn.textContent = 'Send';
function submit() {
  const text = input.value.trim();
  if (!text) return;
  send('chat-message', { text });
  input.value = '';
}
sendBtn.onclick = submit;
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
form.appendChild(input);
form.appendChild(sendBtn);
panel.appendChild(form);

function renderMessages() {
  list.innerHTML = '';
  messages.forEach((m) => {
    const line = document.createElement('div');
    line.className = 'chat-line';
    const name = document.createElement('span');
    name.className = 'chat-name';
    // Seat number prefix (P1, P2, ...) disambiguates two players who
    // picked the same display name, and doubles as a quick cross-reference
    // to the seat list either way.
    const seatLabel = m.seatIndex != null ? `P${m.seatIndex + 1}: ` : '';
    name.textContent = `${seatLabel}${m.name}: `;
    line.appendChild(name);
    line.appendChild(document.createTextNode(m.text));
    list.appendChild(line);
  });
  list.scrollTop = list.scrollHeight;
}
renderMessages();

export function addChatMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_VISIBLE) messages.shift();
  // A new message can arrive at any time (including mid-typing, from
  // another player) - re-render the list immediately rather than waiting
  // for the next renderChatPanel() call, same as the old behavior.
  renderMessages();
}

// Returns the SAME persistent <div class="chat-panel"> node every call -
// callers just re-append it wherever it belongs in that render pass (a
// node can only have one parent at a time in the DOM, so appendChild here
// implicitly moves it out of wherever it was before). The node's own
// value/caret position survive that move automatically since it's the
// same real <input> element throughout, never recreated - only focus
// itself needs an explicit restore, since detaching a focused element
// from the document (root.innerHTML = '' upstream) blurs it even though
// the element object stays alive.
export function renderChatPanel() {
  if (wasFocused) {
    // Next frame, not synchronous - the caller still needs to actually
    // append `panel` into the new tree (and that tree into `root`) after
    // this function returns; focusing before it's attached to the
    // document again is a silent no-op.
    requestAnimationFrame(() => {
      if (document.activeElement !== input) input.focus();
    });
  }
  return panel;
}
