import { CHARACTERS } from './characters.js';
import { send } from './net.js';
import { renderChatPanel } from './chatPanel.js';
import { renderFullscreenButton } from './fullscreen.js';
import { hardRefresh } from './assetVersion.js';

// Whether the About panel is open - module state (not part of the shared
// `state` object in main.js), same reasoning as battleScreen.js's
// drawerOpen: this whole screen tears down and rebuilds on every server
// broadcast, so a plain local variable here is what actually survives
// across those rebuilds. Only ever shown on the entry screen (no room
// yet) - see renderLobby below.
let aboutOpen = false;

// Which seat index (if any) has an armed "Kick this player? Yes/No"
// confirmation showing - same module-state reasoning as aboutOpen above,
// and same "no native popup, inline confirm instead" convention as
// battleScreen.js's Exit Game. null when nothing is armed. Reset whenever
// the room itself changes (see renderRoomLobby) so a stale confirm from a
// PREVIOUS room's seat list can never linger into a new one.
let confirmingKickSeatIndex = null;

// Which seat index (if any) has its "choose the bot's character" grid
// expanded - same module-state/reset-on-room-change reasoning as
// confirmingKickSeatIndex above.
let choosingBotSeatIndex = null;

// Renders the pre-match lobby: room type choice -> create/join -> seat
// list + character picking -> start. `room` is null until a create-room or
// join-room response/lobby-update has arrived at least once.
export function renderLobby(root, { room, error, connectionLost }, { onEnterMatch, rerender }) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'lobby';

  // A row (not absolute-positioned over the title) so the icon cluster
  // never overlaps/hides the centered "Soul Clash Online" text - on a
  // narrow phone screen, 3 icons (About, Hard Refresh, Fullscreen) wide
  // enough to run under an absolutely-positioned title previously did
  // exactly that.
  const header = document.createElement('div');
  header.className = 'lobby-header';

  const title = document.createElement('h1');
  title.textContent = 'Soul Clash Online';
  header.appendChild(title);

  const topControls = document.createElement('div');
  topControls.className = 'top-right-controls';
  // Only on the entry screen (no room yet) - a landing-page credit, not
  // something needed once you're already in a room or mid-match.
  if (!room) topControls.appendChild(renderAboutButton(rerender));
  topControls.appendChild(renderHardRefreshButton());
  topControls.appendChild(renderFullscreenButton());
  header.appendChild(topControls);

  wrap.appendChild(header);

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

  if (!room && aboutOpen) wrap.appendChild(renderAboutPanel());

  // Everything below (entry form or room lobby, including the character
  // grids and chat panel) lives inside its own scroll region, not the page
  // itself - the title/top-controls above stay a fixed header, matching
  // battleScreen.js's .battle-scroll shell. Without this, the entry form's
  // stacked sections (create/join/bot-show, several with a full character
  // grid) routinely ran taller than a phone screen.
  const scroll = document.createElement('div');
  scroll.className = 'lobby-scroll';

  if (!room) {
    scroll.appendChild(renderEntryForm());
  } else if (room.phase === 'in-match') {
    onEnterMatch();
    return;
  } else {
    // Exit Room needs to land in topControls (already appended above,
    // next to the fullscreen button) rather than its own row inside the
    // room lobby - passed down so renderRoomLobby can push its icon button
    // into that same shared top-right cluster.
    scroll.appendChild(renderRoomLobby(room, topControls, rerender));
  }

  wrap.appendChild(scroll);
  root.appendChild(wrap);
}

// Icon button matching fullscreen/exit's exact corner style - toggles
// aboutOpen and re-renders (no native dialog/popup, same "no popups"
// convention as every other inline confirmation in this app).
function renderAboutButton(rerender) {
  const btn = document.createElement('button');
  btn.className = 'about-icon-btn';
  btn.title = 'About';
  btn.textContent = 'ℹ️';
  btn.onclick = () => { aboutOpen = !aboutOpen; rerender(); };
  return btn;
}

// Icon button matching fullscreen/about's exact corner style - bumps the
// cache-busting version token and reloads immediately (see
// assetVersion.js's hardRefresh). One click, no confirmation - a page
// reload is low-stakes (same as an accidental browser refresh; nothing
// server-side is affected, you just reconnect as a fresh session), and
// this exists specifically to recover from a stale-cached image/sound
// under an unchanged filename, which forcing a confirmation step wouldn't
// meaningfully protect against.
function renderHardRefreshButton() {
  const btn = document.createElement('button');
  btn.className = 'hard-refresh-btn';
  btn.title = 'Hard Refresh (fixes stuck/stale images or sounds)';
  btn.textContent = '🔄';
  btn.onclick = () => hardRefresh();
  return btn;
}

function renderAboutPanel() {
  const panel = document.createElement('div');
  panel.className = 'about-panel';
  const text = document.createElement('p');
  text.className = 'about-text';
  text.textContent = 'Somewhere between time, shadow, and thunder, souls were born — not from myth, but from restless nights of imagination. Soul Clash was never meant to be just a game. It began as a question: what if the forces we can\'t control — time, chaos, fate — could be given a face, a name, a fight? Created in silence, released into the world by one mind, this is only the beginning of the Clash.';
  panel.appendChild(text);
  const credit = document.createElement('div');
  credit.className = 'about-credit';
  credit.textContent = 'Sk. Farhad Kamal · remindfarhad@gmail.com';
  panel.appendChild(credit);
  return panel;
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

  const nameRequiredButtons = [];
  function updateNameValidity() {
    const hasName = currentName().length > 0;
    nameInput.classList.toggle('input--invalid', !hasName);
    nameHint.style.display = hasName ? 'none' : 'block';
    if (hasName) sessionStorage.setItem('soulclash-name', currentName());
    [btn4p, joinBtn, ...nameRequiredButtons].forEach((btn) => { btn.disabled = !hasName; });
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
  roomTypeRow.appendChild(btn4p);
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

  const botShowSection = document.createElement('div');
  botShowSection.className = 'bot-show-section';
  const botShowTitle = document.createElement('h2');
  botShowTitle.textContent = 'Watch bots play';
  botShowSection.appendChild(botShowTitle);
  const botShowBtn = document.createElement('button');
  botShowBtn.textContent = 'Start Watching (Random 4)';
  botShowBtn.onclick = () => send('create-bot-show-room', { name: currentName() });
  nameRequiredButtons.push(botShowBtn); // reuses the same name-required disable wiring as the training grid
  botShowSection.appendChild(botShowBtn);
  form.appendChild(botShowSection);

  // The standalone "Watch bots play (your picks)" custom-4-character
  // screen was removed (confirmed ruling) - the owner can now get the same
  // all-bot spectacle from within a normal room via the "Make All Bots"
  // action (see renderRoomLobby/handleFillAllBots in index.js) instead of
  // a separate pre-room flow. Only the simple random-draw "Start Watching"
  // button above remains.

  updateNameValidity();
  return form;
}

// Tracks which room's seat list confirmingKickSeatIndex currently applies
// to - a stale "confirm kick on seat 2" from a PREVIOUS room must never
// silently apply to seat 2 of a brand new room with completely different
// occupants.
let confirmingKickRoomCode = null;

function renderRoomLobby(room, topControls, rerender) {
  if (confirmingKickRoomCode !== room.code) {
    confirmingKickRoomCode = room.code;
    confirmingKickSeatIndex = null;
    choosingBotSeatIndex = null;
  }
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

  // Icon button in the shared top-right cluster (next to fullscreen),
  // not its own full-width row between the code and seat list - same
  // "compact corner control, not a standalone banner" fix already applied
  // to the in-match Exit Game button (see battleScreen.js). Available to
  // ANY human seated in the room, not just the owner - a non-owner player
  // previously had no way to leave the room at all once they'd joined.
  // Available to anyone in the room, seated or Guest - a bare Guest
  // (room.mySeatIndex === null, room.youAreGuest true) previously had NO
  // way to leave the room at all once they'd joined, since this was
  // gated on mySeatIndex alone.
  if (room.mySeatIndex !== null || room.youAreGuest) {
    const exitBtn = document.createElement('button');
    exitBtn.className = 'exit-icon-btn';
    exitBtn.title = 'Exit Room';
    exitBtn.textContent = '🚪';
    exitBtn.onclick = () => send('leave-room');
    topControls.appendChild(exitBtn);
  }

  const seatList = document.createElement('div');
  seatList.className = 'seat-list';

  room.seats.forEach((seat) => {
    const row = document.createElement('div');
    row.className = 'seat-row' + (seat.isMe ? ' seat-row--me' : '');

    // Seat index directly determines turn order once the match starts (seat
    // 1 acts first, then seat 2, etc.) - letting the owner reorder seats
    // here is how they choose turn order, not just cosmetic. Swaps with the
    // adjacent seat rather than a free drag-to-anywhere reorder, which is
    // both simpler to build reliably on mobile (no drag gesture to fight
    // with a scrolling list) and trivial for the server to validate (just a
    // bounds check, not verifying an incoming permutation).
    if (room.youAreOwner) {
      const reorderControls = document.createElement('span');
      reorderControls.className = 'seat-reorder-controls';
      const upBtn = document.createElement('button');
      upBtn.className = 'seat-reorder-btn';
      upBtn.textContent = '▲';
      upBtn.title = 'Move up';
      upBtn.disabled = seat.index === 0;
      upBtn.onclick = () => send('reorder-seats', { seatIndex: seat.index, direction: -1 });
      reorderControls.appendChild(upBtn);
      const downBtn = document.createElement('button');
      downBtn.className = 'seat-reorder-btn';
      downBtn.textContent = '▼';
      downBtn.title = 'Move down';
      downBtn.disabled = seat.index === room.seats.length - 1;
      downBtn.onclick = () => send('reorder-seats', { seatIndex: seat.index, direction: 1 });
      reorderControls.appendChild(downBtn);
      row.appendChild(reorderControls);
    }

    // Label + picks stacked as one compact two-line block instead of two
    // separate flex-wrapped items - previously, on a narrow screen, the
    // label, picks text, and action button each wrapped onto their own
    // full-width line, making every seat row much taller than it needed
    // to be.
    const info = document.createElement('span');
    info.className = 'seat-info';

    const label = document.createElement('span');
    label.className = 'seat-label';
    if (seat.kind === 'empty') label.textContent = `Seat ${seat.index + 1}: (empty)`;
    else if (seat.kind === 'bot') label.textContent = `Seat ${seat.index + 1}: Bot`;
    else label.textContent = `Seat ${seat.index + 1}: ${seat.name}${seat.isOwner ? ' (owner)' : ''}${seat.isMe ? ' (you)' : ''}`;
    info.appendChild(label);

    const picks = document.createElement('span');
    picks.className = 'seat-picks';
    picks.textContent = seat.characterIds.map((id) => CHARACTERS[id].name).join(' + ') || '(no character yet)';
    info.appendChild(picks);

    row.appendChild(info);

    const actions = document.createElement('span');
    actions.className = 'seat-actions';

    if (seat.kind === 'empty' && room.youAreOwner) {
      const botBtn = document.createElement('button');
      botBtn.textContent = 'Fill with Bot';
      botBtn.onclick = () => send('fill-bot', { seatIndex: seat.index });
      actions.appendChild(botBtn);
      // "Choose..." toggles an inline character grid for THIS seat (same
      // no-popup, inline-expand convention as the kick confirmation above)
      // rather than a random draw - picking one sends fill-bot-with-character
      // and collapses the picker; the random "Fill with Bot" button above
      // stays available for whoever doesn't care which character it gets.
      const chooseBtn = document.createElement('button');
      chooseBtn.textContent = choosingBotSeatIndex === seat.index ? 'Choose... ▴' : 'Choose... ▾';
      chooseBtn.onclick = () => {
        choosingBotSeatIndex = choosingBotSeatIndex === seat.index ? null : seat.index;
        rerender();
      };
      actions.appendChild(chooseBtn);
    }
    if (seat.kind === 'bot' && room.youAreOwner) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove Bot';
      removeBtn.onclick = () => send('remove-bot', { seatIndex: seat.index });
      actions.appendChild(removeBtn);
    }
    // Unseat a real human player (moves them to Guest status in this same
    // room, rather than removing them entirely - renamed from "Kick" per
    // explicit request, since being pulled off a character seat no longer
    // means being ejected from the room) - never offered for your own seat
    // (isMe), never a bot seat (that's Remove Bot above), and lobby-only
    // just like every other seat-management action here - the server
    // enforces the same, this just keeps the button from ever appearing
    // somewhere it'd silently no-op.
    if (seat.kind === 'human' && !seat.isMe && room.youAreOwner) {
      if (confirmingKickSeatIndex === seat.index) {
        const prompt = document.createElement('span');
        prompt.className = 'kick-confirm-prompt';
        prompt.textContent = `Move ${seat.name} to Guest?`;
        actions.appendChild(prompt);
        const yesBtn = document.createElement('button');
        yesBtn.className = 'kick-confirm-yes';
        yesBtn.textContent = 'Yes, unseat';
        yesBtn.onclick = () => {
          send('unseat-player', { seatIndex: seat.index });
          confirmingKickSeatIndex = null;
          rerender();
        };
        actions.appendChild(yesBtn);
        const noBtn = document.createElement('button');
        noBtn.className = 'kick-confirm-no';
        noBtn.textContent = 'No';
        noBtn.onclick = () => { confirmingKickSeatIndex = null; rerender(); };
        actions.appendChild(noBtn);
      } else {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'kick-btn';
        kickBtn.textContent = 'Unseat';
        kickBtn.onclick = () => { confirmingKickSeatIndex = seat.index; rerender(); };
        actions.appendChild(kickBtn);
      }
    }

    row.appendChild(actions);

    seatList.appendChild(row);

    if (seat.kind === 'empty' && room.youAreOwner && choosingBotSeatIndex === seat.index) {
      const chooseGrid = document.createElement('div');
      chooseGrid.className = 'character-grid bot-choose-grid';
      Object.values(CHARACTERS).forEach((def) => {
        const available = room.availableCharacterIds.includes(def.id);
        const btn = document.createElement('button');
        btn.textContent = def.name;
        btn.disabled = !available;
        btn.style.borderColor = def.color;
        btn.onclick = () => {
          send('fill-bot-with-character', { seatIndex: seat.index, characterId: def.id });
          choosingBotSeatIndex = null;
        };
        chooseGrid.appendChild(btn);
      });
      seatList.appendChild(chooseGrid);
    }
  });
  wrap.appendChild(seatList);

  // Guest list - watch-only members, listed separately from the 4 player
  // seats above. Shows the current/max member count (confirmed 10-member
  // cap, flexibly shared between seats and Guests - see rooms.js's
  // totalRoomMembers) so it's clear at a glance how much room is left.
  if (room.guests.length > 0 || room.youAreGuest) {
    const guestSection = document.createElement('div');
    guestSection.className = 'guest-section';
    const guestTitle = document.createElement('h3');
    guestTitle.textContent = `Guests (${room.memberCount}/${room.maxMembers} total in room)`;
    guestSection.appendChild(guestTitle);
    const guestList = document.createElement('div');
    guestList.className = 'guest-list';
    room.guests.forEach((guest) => {
      const chip = document.createElement('span');
      chip.className = 'guest-chip' + (guest.isMe ? ' guest-chip--me' : '');
      chip.textContent = guest.name + (guest.isOwner ? ' (owner)' : '') + (guest.isMe ? ' (you)' : '');
      guestList.appendChild(chip);
    });
    guestSection.appendChild(guestList);
    wrap.appendChild(guestSection);
  }

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

    // Converts every seat to a bot in one click, including any seat
    // currently held by a real human (who becomes a Guest, same as the
    // per-seat Unseat button above) - replaces the old standalone
    // "Watch bots play (your picks)" entry-screen flow (confirmed
    // ruling), now available from within a normal room instead.
    const fillAllBtn = document.createElement('button');
    fillAllBtn.className = 'fill-all-bots-btn';
    fillAllBtn.textContent = 'Make All Bots';
    fillAllBtn.onclick = () => send('fill-all-bots');
    wrap.appendChild(fillAllBtn);
  } else {
    const waiting = document.createElement('div');
    waiting.className = 'waiting-note';
    waiting.textContent = 'Waiting for the room owner to start the match...';
    wrap.appendChild(waiting);
  }

  wrap.appendChild(renderChatPanel());

  return wrap;
}
