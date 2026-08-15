/**
 * GRID UI — T11: right-pane 3×3 reactive canvas.
 *
 * Renders `dashboard_cards` onto the CSS grid, provides card CRUD (add/edit
 * dialog, per-card refresh/edit/delete, refresh-all), and implements the
 * change-triggered reactivity that is T18's groundwork:
 *
 *   update_hook (harness.js) ──▶ 'data_change' events on the event stream
 *     ──▶ noteDataChange() accumulates changed DATA tables
 *     ──▶ flush: resolve each card's base-table dependencies (grid.js
 *         resolveCardTables — views expanded to their tables) and re-run the
 *         cards whose dependencies intersect the changed tables.
 *
 * Busy-gating: while a turn / scratchpad / CSV ingest is in flight, changes
 * live inside a savepoint that may still roll back — so re-runs are deferred
 * to the committed point. main.js calls setBusy(on) from setLoading() and
 * flushCards() from each path's finally block (after RELEASE / ROLLBACK).
 * Out-of-turn changes debounce 300 ms and flush on their own.
 *
 * The 9 `.grid-cell` nodes rendered behind the cards are the drop-zone
 * anchors T12 will attach HTML5 drag-and-drop handlers to (T12 itself is not
 * implemented here).
 */

import { getEventStream } from './harness.js';
import {
  listCards, addCard, updateCard, removeCard,
  runCardSql, affectedCards,
  GRID_ROWS, GRID_COLS, CARD_ROW_CAP,
} from './grid.js';
import { queryAll } from './schema.js';

let agent = null;
let busy = false;
let pendingTables = new Set();
let flushTimer = null;
let streamAttached = false;
let editingCardId = null; // null = add mode

// ── Init ──────────────────────────────────────────────────────────────

export function initGridUi(agentHandle) {
  agent = agentHandle;
  attachStream();

  document.getElementById('btn-add-card')?.addEventListener('click', () => openCardDialog('add'));
  document.getElementById('btn-refresh-all')?.addEventListener('click', () => {
    refreshAllCards().catch(e => console.warn('[grid-ui] refresh-all failed:', e));
  });
  document.getElementById('card-cancel')?.addEventListener('click', closeCardDialog);
  document.getElementById('card-dialog')?.addEventListener('click', (e) => {
    if (e.target.id === 'card-dialog') closeCardDialog(); // backdrop click
  });
  document.getElementById('card-form')?.addEventListener('submit', onCardFormSubmit);
  // Escape closes the dialog (backdrop click + Cancel already do).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dlg = document.getElementById('card-dialog');
    if (dlg && !dlg.classList.contains('hidden')) closeCardDialog();
  });

  renderGrid().catch(e => console.warn('[grid-ui] initial render failed:', e));
  renderExplorer().catch(e => console.warn('[grid-ui] explorer render failed:', e));
}

/** Subscribe to the shared event stream for 'data_change' events. */
function attachStream() {
  if (streamAttached) return;
  streamAttached = true;
  const reader = getEventStream().getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.type === 'data_change' && value.table) noteDataChange(value.table);
      }
    } catch (e) {
      console.warn('[grid-ui] event stream reader error:', e);
    }
  })();
}

// ── Busy gating (turn / scratchpad / ingest in flight) ────────────────

export function setBusy(on) {
  busy = !!on;
  // Card CRUD and refreshes are disabled mid-turn: a card INSERT issued while
  // the turn savepoint is open would join that transaction and be rolled back
  // with it on a hard error (UI/DB desync).
  document.getElementById('canvas-pane')?.classList.toggle('disabled', on);
}

/**
 * Called by main.js at committed points (turn end, scratchpad end, CSV
 * ingest end — after RELEASE / ROLLBACK). Re-runs cards whose base tables
 * changed. Returns the number of cards refreshed.
 */
export async function flushCards() {
  if (!agent || busy || pendingTables.size === 0) return 0;
  const changed = [...pendingTables];
  pendingTables.clear();
  const cards = await listCards(agent.sqlite3, agent.db);
  const affected = await affectedCards(agent.sqlite3, agent.db, cards, changed);
  for (const card of affected) await refreshCard(card.id, { live: true, card });
  return affected.length;
}

/** Record a data-table change (from the event stream). */
function noteDataChange(table) {
  pendingTables.add(table);
  if (busy) return; // deferred to the turn-end flushCards()
  scheduleFlush(300);
}

function scheduleFlush(delayMs) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushCards().catch(e => console.warn('[grid-ui] flush failed:', e));
  }, delayMs);
}

// ── Rendering ─────────────────────────────────────────────────────────

/** Full grid re-render from the DB (boot, after CRUD, after cartridge import). */
export async function renderGrid() {
  if (!agent) return;
  const grid = document.getElementById('dashboard-grid');
  if (!grid) return;
  const cards = await listCards(agent.sqlite3, agent.db);

  grid.innerHTML = '';
  // 9 drop-zone cells (T12 attaches drag-and-drop handlers here).
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.style.gridRow = `${r + 1} / span 1`;
      cell.style.gridColumn = `${c + 1} / span 1`;
      grid.appendChild(cell);
    }
  }

  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'grid-empty';
    empty.textContent = 'No cards yet — click “+ Add card” to pin a live query';
    grid.appendChild(empty);
    return;
  }

  for (const card of cards) grid.appendChild(buildCardEl(card));
  // Single-threaded DB: run card SQL sequentially. Pass the row we already
  // have so refreshCard doesn't re-query listCards() per card.
  for (const card of cards) await refreshCard(card.id, { card });
}

/** Rebuild the whole grid + explorer (cartridge import replaced the DB). */
export async function rebuildGrid() {
  if (!agent) return;
  pendingTables.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await renderGrid();
  await renderExplorer();
}

/** Re-run every card's SQL (manual Refresh-all). */
export async function refreshAllCards() {
  if (!agent || busy) return;
  const cards = await listCards(agent.sqlite3, agent.db);
  for (const card of cards) await refreshCard(card.id, { card });
}

/** Re-run one card's SQL and update its body in place. */
export async function refreshCard(id, { live = false, card: knownCard = null } = {}) {
  if (!agent || busy) return;
  const el = document.querySelector(`.dash-card[data-card-id="${id}"]`);
  if (!el) return;
  // Callers that already hold the card row (renderGrid / refreshAllCards /
  // flushCards) pass it in to avoid a redundant listCards() round-trip per card.
  let card = knownCard;
  if (!card) {
    const cards = await listCards(agent.sqlite3, agent.db);
    card = cards.find(c => c.id === id);
  }
  if (!card) { el.remove(); return; } // deleted out from under us

  const res = await runCardSql(agent.sqlite3, agent.db, card.sql);
  renderCardBody(el, card, res);

  const footer = el.querySelector('.dash-card-footer');
  if (footer) {
    const stamp = new Date().toLocaleTimeString();
    footer.textContent = `updated ${stamp} · ${res.ms} ms` + (live ? ' · live' : '');
  }
  if (live) {
    el.classList.remove('card-live-flash');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('card-live-flash');
  }
}

function buildCardEl(card) {
  const el = document.createElement('article');
  el.className = 'dash-card';
  el.dataset.cardId = String(card.id);
  el.style.gridRow = `${card.row + 1} / span ${card.row_span}`;
  el.style.gridColumn = `${card.col + 1} / span ${card.col_span}`;
  el.innerHTML = `
    <header class="dash-card-header">
      <span class="dash-card-title"></span>
      <div class="dash-card-actions">
        <button type="button" class="card-btn card-refresh" title="Refresh card">⟳</button>
        <button type="button" class="card-btn card-edit" title="Edit card">✎</button>
        <button type="button" class="card-btn card-delete" title="Delete card">✕</button>
      </div>
    </header>
    <div class="dash-card-body"><em class="card-loading">running…</em></div>
    <footer class="dash-card-footer"></footer>`;
  el.querySelector('.dash-card-title').textContent = card.title;
  el.querySelector('.card-refresh').addEventListener('click', () => {
    refreshCard(card.id).catch(e => console.warn('[grid-ui] refresh failed:', e));
  });
  el.querySelector('.card-edit').addEventListener('click', () => openCardDialog('edit', card));
  el.querySelector('.card-delete').addEventListener('click', () => deleteCard(card));
  return el;
}

function renderCardBody(el, card, res) {
  const body = el.querySelector('.dash-card-body');
  if (!body) return;
  body.innerHTML = '';

  if (res.error) {
    const err = document.createElement('div');
    err.className = 'tool-error card-error';
    err.textContent = `⚠ ${res.error}`;
    body.appendChild(err);
    return;
  }

  // 1×1 result → big metric; anything else → table.
  if (res.values.length === 1 && res.columns.length === 1) {
    const metric = document.createElement('div');
    metric.className = 'card-metric';
    metric.textContent = String(res.values[0][0] ?? 'NULL');
    const label = document.createElement('div');
    label.className = 'card-metric-label';
    label.textContent = res.columns[0];
    body.appendChild(metric);
    body.appendChild(label);
    return;
  }

  if (!res.values.length) {
    body.innerHTML = '<em class="card-empty">(no rows)</em>';
    return;
  }

  let html = '<table class="result-table card-table"><thead><tr>';
  res.columns.forEach(c => html += `<th>${escapeHtml(c)}</th>`);
  html += '</tr></thead><tbody>';
  res.values.forEach(row => {
    html += '<tr>';
    row.forEach(val => html += `<td>${escapeHtml(String(val ?? 'NULL'))}</td>`);
    html += '</tr>';
  });
  html += '</tbody></table>';
  body.innerHTML = html;
  if (res.truncated) {
    const note = document.createElement('div');
    note.className = 'card-truncated';
    note.textContent = `… truncated at ${CARD_ROW_CAP} rows`;
    body.appendChild(note);
  }
}

/** Left-pane DB Explorer shell (T8 fills in the full inspector). */
export async function renderExplorer() {
  if (!agent) return;
  const list = document.getElementById('table-list');
  if (!list) return;
  const rows = await queryAll(agent.sqlite3, agent.db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  list.innerHTML = '';
  for (const [name] of rows) {
    const li = document.createElement('li');
    li.className = 'explorer-table';
    li.textContent = name;
    list.appendChild(li);
  }
}

// ── Card CRUD ─────────────────────────────────────────────────────────

async function deleteCard(card) {
  if (!agent || busy) return; // CSS disables the button mid-turn; this guards
  // keyboard / programmatic paths so a DELETE can't join the turn savepoint.
  if (!confirm(`Delete card "${card.title}"?`)) return;
  try {
    await removeCard(agent.sqlite3, agent.db, card.id);
    await renderGrid();
  } catch (e) {
    console.error('[grid-ui] delete failed:', e);
    alert(`Delete failed: ${e.message}`);
  }
}

/** Open the add/edit dialog. mode: 'add' | 'edit'. */
export function openCardDialog(mode, card = null) {
  editingCardId = mode === 'edit' ? card.id : null;
  const dlg = document.getElementById('card-dialog');
  if (!dlg) return;

  document.getElementById('card-dialog-title').textContent =
    mode === 'edit' ? 'Edit dashboard card' : 'New dashboard card';
  document.getElementById('card-title').value = card ? card.title : '';
  document.getElementById('card-sql').value = card ? card.sql : '';
  document.getElementById('card-row').value = String(card ? card.row : 0);
  document.getElementById('card-col').value = String(card ? card.col : 0);
  document.getElementById('card-row-span').value = String(card ? card.row_span : 1);
  document.getElementById('card-col-span').value = String(card ? card.col_span : 1);
  // Position is explicit in edit mode; add mode auto-packs the first fitting spot.
  document.getElementById('card-placement-row').classList.toggle('hidden', mode !== 'edit');
  document.getElementById('card-submit').textContent = mode === 'edit' ? 'Save card' : 'Add card';
  clearCardError();
  dlg.classList.remove('hidden');
  document.getElementById('card-title').focus();
}

function closeCardDialog() {
  document.getElementById('card-dialog')?.classList.add('hidden');
  editingCardId = null;
}

function cardError(msg) {
  const el = document.getElementById('card-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearCardError() {
  const el = document.getElementById('card-error');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

async function onCardFormSubmit(e) {
  e.preventDefault();
  // The dialog can be open when a turn starts, or be submitted via Enter while
  // a turn is in flight — CSS disables clicks but not this, so guard the write
  // (an INSERT/UPDATE mid-savepoint would roll back with the turn).
  if (!agent || busy) return;
  const title = document.getElementById('card-title').value;
  const sql = document.getElementById('card-sql').value;
  const row = Number(document.getElementById('card-row').value);
  const col = Number(document.getElementById('card-col').value);
  const rowSpan = Number(document.getElementById('card-row-span').value);
  const colSpan = Number(document.getElementById('card-col-span').value);

  try {
    if (editingCardId == null) {
      // Add: auto-pack the first fitting spot (position selects hidden).
      await addCard(agent.sqlite3, agent.db, { title, sql, rowSpan, colSpan });
    } else {
      await updateCard(agent.sqlite3, agent.db, editingCardId, { title, sql, row, col, rowSpan, colSpan });
    }
    closeCardDialog();
    await renderGrid();
  } catch (err) {
    console.warn('[grid-ui] card save failed:', err);
    cardError(err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
