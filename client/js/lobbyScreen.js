import { CHARACTERS } from './characters.js';
import { send } from './net.js';
import { renderChatPanel } from './chatPanel.js';

// Renders the pre-match lobby: room type choice -> create/join -> seat
// list + character picking -> start. `room` is null until a create-room or
// join-room response/lobby-update has arrived at least once.
export function renderLobby(root, { room, error }, { onEnterMatch }) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'lobby';

  const title = document.createElement('h1');
  title.textContent = 'Soul Clash Online';
  wrap.appendChild(title);

  if (error) {
    const err = document.createElement('div');
    err.className = 'error-banner';
    err.textContent = error;
    wrap.appendChild(err);
  }

  if (!room) {
    wrap.appendChild(renderEntryForm());
  } else if (room.phase === 'in-match') {
    onEnterMatch();
    return;
  } else {
    wrap.appendChild(renderRoomLobby(room));
  }

  root.appendChild(wrap);
}

function renderEntryForm() {
  const form = document.createElement('div');
  form.className = 'entry-form';

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Your name (required)';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 20;
  nameInput.placeholder = 'Enter a display name';
  nameInput.value = sessionStorage.getItem('soulclash-name') || '';
  form.appendChild(nameLabel);
  form.appendChild(nameInput);
  const nameHint = document.createElement('div');
  nameHint.className = 'name-hint';
  nameHint.textContent = 'Enter a name to create or join a room.';
  form.appendChild(nameHint);

  function currentName() {
    return nameInput.value.trim();
  }

  function updateNameValidity() {
    const hasName = currentName().length > 0;
    nameInput.classList.toggle('input--invalid', !hasName);
    nameHint.style.display = hasName ? 'none' : 'block';
    if (hasName) sessionStorage.setItem('soulclash-name', currentName());
    [btn4p, btn2p, joinBtn].forEach((btn) => { btn.disabled = !hasName; });
  }
  nameInput.addEventListener('input', updateNameValidity);

  const createSection = document.createElement('div');
  createSection.className = 'create-section';
  const createTitle = document.createElement('h2');
  createTitle.textContent = 'Create a room';
  createSection.appendChild(createTitle);

  const roomTypeRow = document.createElement('div');
  roomTypeRow.className = 'room-type-row';
  const btn4p = document.createElement('button');
  btn4p.textContent = '4 Player (FFA)';
  btn4p.onclick = () => send('create-room', { roomType: '4p', name: currentName() });
  const btn2p = document.createElement('button');
  btn2p.textContent = '2 Player (2v2)';
  btn2p.onclick = () => send('create-room', { roomType: '2p', name: currentName() });
  roomTypeRow.appendChild(btn4p);
  roomTypeRow.appendChild(btn2p);
  createSection.appendChild(roomTypeRow);
  form.appendChild(createSection);

  const joinSection = document.createElement('div');
  joinSection.className = 'join-section';
  const joinTitle = document.createElement('h2');
  joinTitle.textContent = 'Join a room';
  joinSection.appendChild(joinTitle);

  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.inputMode = 'numeric';
  codeInput.maxLength = 6;
  codeInput.placeholder = '6-digit code';
  codeInput.className = 'code-input';
  const joinBtn = document.createElement('button');
  joinBtn.textContent = 'Join';
  joinBtn.onclick = () => {
    const code = codeInput.value.trim();
    if (code.length === 6) send('join-room', { code, name: currentName() });
  };
  joinSection.appendChild(codeInput);
  joinSection.appendChild(joinBtn);
  form.appendChild(joinSection);

  updateNameValidity();
  return form;
}

function renderRoomLobby(room) {
  const wrap = document.createElement('div');
  wrap.className = 'room-lobby';

  const codeDisplay = document.createElement('div');
  codeDisplay.className = 'room-code';
  codeDisplay.textContent = `Room code: ${room.code}`;
  wrap.appendChild(codeDisplay);

  const seatList = document.createElement('div');
  seatList.className = 'seat-list';

  room.seats.forEach((seat) => {
    const row = document.createElement('div');
    row.className = 'seat-row' + (seat.isMe ? ' seat-row--me' : '');

    const label = document.createElement('span');
    label.className = 'seat-label';
    if (seat.kind === 'empty') label.textContent = `Seat ${seat.index + 1}: (empty)`;
    else if (seat.kind === 'bot') label.textContent = `Seat ${seat.index + 1}: Bot`;
    else label.textContent = `Seat ${seat.index + 1}: ${seat.name}${seat.isOwner ? ' (owner)' : ''}${seat.isMe ? ' (you)' : ''}`;
    row.appendChild(label);

    const picks = document.createElement('span');
    picks.className = 'seat-picks';
    picks.textContent = seat.characterIds.map((id) => CHARACTERS[id].name).join(' + ') || '(no character yet)';
    row.appendChild(picks);

    if (seat.kind === 'empty' && room.youAreOwner) {
      const botBtn = document.createElement('button');
      botBtn.textContent = 'Fill with Bot';
      botBtn.onclick = () => send('fill-bot', { seatIndex: seat.index });
      row.appendChild(botBtn);
    }

    seatList.appendChild(row);
  });
  wrap.appendChild(seatList);

  const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;

  if (mySeat && mySeat.characterIds.length < room.picksPerSeat) {
    const pickSection = document.createElement('div');
    pickSection.className = 'pick-section';
    const pickTitle = document.createElement('h3');
    pickTitle.textContent = `Pick your character${room.picksPerSeat > 1 ? 's' : ''} (${mySeat.characterIds.length}/${room.picksPerSeat})`;
    pickSection.appendChild(pickTitle);

    const grid = document.createElement('div');
    grid.className = 'character-grid';
    Object.values(CHARACTERS).forEach((def) => {
      const available = room.availableCharacterIds.includes(def.id);
      const btn = document.createElement('button');
      btn.textContent = def.name;
      btn.disabled = !available;
      btn.style.borderColor = def.color;
      btn.onclick = () => send('pick-character', { characterId: def.id });
      grid.appendChild(btn);
    });
    pickSection.appendChild(grid);
    wrap.appendChild(pickSection);
  }

  if (room.youAreOwner) {
    // Mirrors the server's own seatIsReady() check (handleStartMatch) -
    // every human-claimed seat must have finished picking; empty seats are
    // fine (bot-filled automatically on start). Without this, clicking
    // Start while someone's still picking silently does nothing server-side
    // (the server just no-ops), which reads as the button being broken.
    const allHumansReady = room.seats.every((s) => s.kind !== 'human' || s.characterIds.length === room.picksPerSeat);
    const startBtn = document.createElement('button');
    startBtn.className = 'start-btn';
    startBtn.textContent = allHumansReady ? 'Start Match' : 'Waiting for players to pick...';
    startBtn.disabled = !allHumansReady;
    startBtn.onclick = () => send('start-match');
    wrap.appendChild(startBtn);
  } else {
    const waiting = document.createElement('div');
    waiting.className = 'waiting-note';
    waiting.textContent = 'Waiting for the room owner to start the match...';
    wrap.appendChild(waiting);
  }

  wrap.appendChild(renderChatPanel());

  return wrap;
}
