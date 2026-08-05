import { send } from './net.js';

// Shared chat panel used by both the lobby and battle screens - messages
// live only in this module's in-memory array for the current tab session
// (no persistence, matches the server's no-history relay).
const messages = [];

export function addChatMessage(msg) {
  messages.push(msg);
  if (messages.length > 200) messages.shift();
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
    name.textContent = `${m.name}: `;
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
  input.maxLength = 300;
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
