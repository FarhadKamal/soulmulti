import { send } from './net.js';

// Shared chat panel used by both the lobby and battle screens - messages
// live only in this module's in-memory array for the current tab session
// (no persistence, matches the server's no-history relay). Kept to short
// callouts only, not a scrollback log - only the most recent MAX_VISIBLE
// messages are ever kept at all (older ones are dropped, not just
// scrolled past), matching the server's 60-char per-message cap.
const MAX_VISIBLE = 10;
const messages = [];

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
  wrap.appendChild(form);

  return wrap;
}
