// Hidden win-rate panel on the main menu (2026-10-20) - no visible button;
// Ctrl+Shift+X toggles it. Reads the server's /api/winrates (4-player
// matches from MongoDB). Same inline-panel pattern as the About and How to
// Play panels in lobbyScreen.js - no native dialogs.
import { CHARACTERS } from './characters.js';

let open = false;
let view = 'allTime'; // or 'last7Days'
let data = null;
let loading = false;
let error = null;

export function isWinRatesOpen() {
  return open;
}

async function load(rerender) {
  loading = true;
  error = null;
  rerender();
  try {
    const res = await fetch('/api/winrates', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
    data = body;
  } catch (err) {
    error = err.message || 'Could not load stats.';
  } finally {
    loading = false;
    rerender();
  }
}

// `isEntryScreen` - only reacts on the main menu (no room yet), so the
// shortcut can't open anything mid-lobby or mid-match.
export function installWinRatesShortcut(isEntryScreen, rerender) {
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x'))) return;
    if (!isEntryScreen()) return;
    e.preventDefault();
    open = !open;
    if (open) load(rerender);
    else rerender();
  });
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '?';
}

export function renderWinRatesPanel(rerender) {
  const panel = document.createElement('div');
  panel.className = 'about-panel winrates-panel';

  const head = document.createElement('div');
  head.className = 'winrates-head';
  const title = document.createElement('h2');
  title.textContent = 'Win Rates (4 players)';
  head.appendChild(title);
  const close = document.createElement('button');
  close.className = 'winrates-close';
  close.textContent = '✕';
  close.title = 'Close (Ctrl+Shift+X)';
  close.onclick = () => { open = false; rerender(); };
  head.appendChild(close);
  panel.appendChild(head);

  if (loading && !data) {
    panel.appendChild(Object.assign(document.createElement('p'), { textContent: 'Loading…' }));
    return panel;
  }
  if (error) {
    const err = Object.assign(document.createElement('p'), { className: 'winrates-error', textContent: error });
    panel.appendChild(err);
    const retry = Object.assign(document.createElement('button'), { className: 'winrates-tab', textContent: 'Retry' });
    retry.onclick = () => load(rerender);
    panel.appendChild(retry);
    return panel;
  }
  if (!data) return panel;

  const tabs = document.createElement('div');
  tabs.className = 'winrates-tabs';
  for (const [key, label] of [['allTime', 'All time'], ['last7Days', 'Last 7 days']]) {
    const tab = document.createElement('button');
    tab.className = 'winrates-tab' + (view === key ? ' winrates-tab--active' : '');
    tab.textContent = label;
    tab.onclick = () => { view = key; rerender(); };
    tabs.appendChild(tab);
  }
  panel.appendChild(tabs);

  const note = document.createElement('p');
  note.className = 'winrates-note';
  const period = view === 'last7Days'
    ? `${data.last7DaysMatches ?? '?'} matches in the last 7 days`
    : `${data.matches} matches, ${formatDate(data.from)} – ${formatDate(data.to)}`;
  note.textContent = `${period}. Draws aren't recorded, so a balanced hero wins about 25%.`;
  panel.appendChild(note);

  const rows = (data[view] || [])
    .map((r) => ({ ...r, rate: r.games ? r.wins / r.games : 0 }))
    .sort((a, b) => b.rate - a.rate || b.games - a.games);

  const table = document.createElement('table');
  table.className = 'winrates-table';
  table.innerHTML = '<thead><tr><th>Hero</th><th>Wins</th><th>Games</th><th>Win rate</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const pct = Math.round(r.rate * 1000) / 10;
    const band = pct >= 30 ? 'high' : pct <= 20 ? 'low' : 'mid';
    const cells = [CHARACTERS[r.id]?.name || r.id, r.wins, r.games];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    const rateCell = document.createElement('td');
    rateCell.className = 'winrates-rate';
    const bar = document.createElement('span');
    bar.className = `winrates-bar winrates-bar--${band}`;
    bar.style.width = `${Math.min(100, pct * 2)}%`;
    const label = document.createElement('span');
    label.className = 'winrates-pct';
    label.textContent = `${pct}%`;
    rateCell.append(bar, label);
    tr.appendChild(rateCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
  if (rows.length === 0) {
    panel.appendChild(Object.assign(document.createElement('p'), { className: 'winrates-note', textContent: 'No matches in this period.' }));
  }
  return panel;
}
