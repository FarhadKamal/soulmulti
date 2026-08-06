import { CHARACTERS } from './characters.js';
import { send } from './net.js';
import { renderChatPanel } from './chatPanel.js';
import { renderRulesModal } from './rulesScreen.js';
import { renderFullscreenButton } from './fullscreen.js';
import { playUiClick } from './sound.js';

// Renders the pre-match lobby: room type choice -> create/join -> seat
// list + character picking -> start. `room` is null until a create-room or
// join-room response/lobby-update has arrived at least once.
export function renderLobby(root, { room, error, connectionLost }, { onEnterMatch }) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'lobby';
  wrap.style.position = 'relative';

  const title = document.createElement('h1');
  title.textContent = 'Soul Clash Online';
  wrap.appendChild(title);

  const topControls = document.createElement('div');
  topControls.className = 'top-right-controls';
  const rulesBtn = document.createElement('button');
  rulesBtn.className = 'how-to-play-btn';
  rulesBtn.textContent = 'How to Play';
  rulesBtn.onclick = () => {
    playUiClick();
    renderRulesModal(document.body);
  };
  topControls.appendChild(rulesBtn);
  topControls.appendChild(renderFullscreenButton());
  wrap.appendChild(topControls);

  if (error) {
    const err = document.createElement('div');
    err.className = 'error-banner';
    const text = document.createElement('span');
    text.textContent = error;
    err.appendChild(text);
    if (connectionLost) {
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'refresh-btn';
      refreshBtn.textContent = 'Refresh';
      // A plain reload is correct here (unlike return-to-lobby's dedicated
      // message) - the socket is already dead with nothing salvageable, so
      // starting a completely fresh session is the actual recovery path.
      refreshBtn.onclick = () => window.location.reload();
      err.appendChild(refreshBtn);
    }
    wrap.appendChild(err);
  }

  if (connectionLost) {
    // Nothing else on this screen can do anything useful anymore - every
    // button here would just try to send over a dead socket.
    root.appendChild(wrap);
    return;
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

  const tutorialButtons = [];
  function updateNameValidity() {
    const hasName = currentName().length > 0;
    nameInput.classList.toggle('input--invalid', !hasName);
    nameHint.style.display = hasName ? 'none' : 'block';
    if (hasName) sessionStorage.setItem('soulclash-name', currentName());
    [btn4p, btn2p, joinBtn, ...tutorialButtons].forEach((btn) => { btn.disabled = !hasName; });
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

  const tutorialSection = document.createElement('div');
  tutorialSection.className = 'tutorial-section';
  const tutorialTitle = document.createElement('h2');
  tutorialTitle.textContent = 'Learn to play (Tutorial)';
  tutorialSection.appendChild(tutorialTitle);
  const tutorialHint = document.createElement('div');
  tutorialHint.className = 'name-hint';
  tutorialHint.textContent = 'Pick a character - a guided 1v1 walks you through their moves.';
  tutorialSection.appendChild(tutorialHint);

  const tutorialGrid = document.createElement('div');
  tutorialGrid.className = 'character-grid';
  Object.values(CHARACTERS).forEach((def) => {
    const btn = document.createElement('button');
    btn.textContent = def.name;
    btn.style.borderColor = def.color;
    btn.onclick = () => send('create-tutorial-room', { name: currentName(), characterId: def.id });
    tutorialButtons.push(btn);
    tutorialGrid.appendChild(btn);
  });
  tutorialSection.appendChild(tutorialGrid);
  form.appendChild(tutorialSection);

  updateNameValidity();
  return form;
}

function renderRoomLobby(room) {
  const wrap = document.createElement('div');
  wrap.className = 'room-lobby';

  const codeRow = document.createElement('div');
  codeRow.className = 'room-code-row';
  const codeDisplay = document.createElement('div');
  codeDisplay.className = 'room-code';
  codeDisplay.textContent = `Room code: ${room.code}`;
  codeRow.appendChild(codeDisplay);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-code-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) - fall back to a
      // manual select+copy via a temporary input, which document.execCommand
      // can still handle in more contexts than the async Clipboard API.
      const temp = document.createElement('input');
      temp.value = room.code;
      document.body.appendChild(temp);
      temp.select();
      try { document.execCommand('copy'); } catch { /* give up silently */ }
      document.body.removeChild(temp);
    }
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  };
  codeRow.appendChild(copyBtn);
  wrap.appendChild(codeRow);

  if (room.youAreOwner) {
    const exitBtn = document.createElement('button');
    exitBtn.className = 'exit-btn';
    exitBtn.textContent = 'Exit Room';
    exitBtn.onclick = () => send('leave-room');
    wrap.appendChild(exitBtn);
  }

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
    if (seat.kind === 'bot' && room.youAreOwner) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove Bot';
      removeBtn.onclick = () => send('remove-bot', { seatIndex: seat.index });
      row.appendChild(removeBtn);
    }

    seatList.appendChild(row);
  });
  wrap.appendChild(seatList);

  const mySeat = room.mySeatIndex !== null ? room.seats[room.mySeatIndex] : null;

  // Kept visible even once fully picked (not gated on < picksPerSeat) so a
  // player can change their mind before the match starts - clicking one of
  // their own picked characters below removes it, freeing a slot to pick a
  // different one instead of being locked in.
  if (mySeat) {
    const pickSection = document.createElement('div');
    pickSection.className = 'pick-section';
    const pickTitle = document.createElement('h3');
    pickTitle.textContent = `Your character${room.picksPerSeat > 1 ? 's' : ''} (${mySeat.characterIds.length}/${room.picksPerSeat})`;
    pickSection.appendChild(pickTitle);

    if (mySeat.characterIds.length > 0) {
      const pickedRow = document.createElement('div');
      pickedRow.className = 'picked-row';
      mySeat.characterIds.forEach((id) => {
        const def = CHARACTERS[id];
        const chip = document.createElement('button');
        chip.className = 'picked-chip';
        chip.style.borderColor = def.color;
        chip.textContent = `${def.name} ×`;
        chip.title = 'Click to unpick';
        chip.onclick = () => send('unpick-character', { characterId: id });
        pickedRow.appendChild(chip);
      });
      pickSection.appendChild(pickedRow);
    }

    if (mySeat.characterIds.length < room.picksPerSeat) {
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
    }
    wrap.appendChild(pickSection);
  }

  if (room.youAreOwner) {
    // Mirrors the server's own handleStartMatch checks - every
    // human-claimed seat must have finished picking, AND no seat may be
    // left empty (a removed bot's seat must be refilled - "Fill with Bot"
    // or a real player joining - before Start becomes clickable; there's
    // no more silent auto-fill-on-start). Without this, clicking Start
    // while either condition fails silently does nothing server-side (the
    // server just no-ops), which reads as the button being broken.
    const allHumansReady = room.seats.every((s) => s.kind !== 'human' || s.characterIds.length === room.picksPerSeat);
    const hasEmptySeat = room.seats.some((s) => s.kind === 'empty');
    const canStart = allHumansReady && !hasEmptySeat;
    const startBtn = document.createElement('button');
    startBtn.className = 'start-btn';
    startBtn.textContent = hasEmptySeat
      ? 'Fill all seats to start'
      : (allHumansReady ? 'Start Match' : 'Waiting for players to pick...');
    startBtn.disabled = !canStart;
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
