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
// BOT_ACTION_DELAY_MS in the server), which was silently recreating this
// panel's <input> from scratch each time: whatever you were mid-typing got
// wiped, and focus was lost even if you'd just clicked into the box.
// Persisting the draft text and whether the input was focused here (module
// state survives across renders, unlike the DOM node itself) lets
// renderChatPanel restore both after rebuilding.
let draftText = '';
let wasFocused = false;

export function addChatMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_VISIBLE) messages.shift();
}

export function renderChatPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'chat-panel';

  const title = document.createElement('div');
  title.className = 'chat-title';
  title.textContent = 'Chat';
  wrap.appendChild(title);

  const list = document.createElement('div');
  list.className = 'chat-messages';
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
  wrap.appendChild(list);
  // Auto-scroll to the latest message.
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });

  const form = document.createElement('div');
  form.className = 'chat-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 60;
  input.placeholder = 'Type a message...';
  // Restore whatever was mid-typing (and refocus) across this rebuild - see
  // draftText/wasFocused above for why this is necessary at all.
  input.value = draftText;
  input.addEventListener('input', () => { draftText = input.value; });
  input.addEventListener('focus', () => { wasFocused = true; });
  input.addEventListener('blur', () => { wasFocused = false; });
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    send('chat-message', { text });
    input.value = '';
    draftText = '';
  }
  sendBtn.onclick = submit;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  form.appendChild(input);
  form.appendChild(sendBtn);
  wrap.appendChild(form);

  if (wasFocused) {
    // Re-focus on the NEXT frame, not synchronously - the freshly created
    // input isn't attached to the document yet at this point (the caller
    // still needs to append this whole wrap into root), and .focus() on a
    // detached element is a silent no-op.
    requestAnimationFrame(() => {
      input.focus();
      // Restore the caret to the end rather than letting focus() jump it
      // to position 0, which would otherwise make continued typing insert
      // backwards through the restored draft text.
      const pos = input.value.length;
      input.setSelectionRange(pos, pos);
    });
  }

  return wrap;
}
