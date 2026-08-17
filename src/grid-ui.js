/**
 * GRID UI — Ticket 11, Ticket 12 & Ticket 25: 3×3 Dynamic Reactive Canvas
 *
 * Renders `dashboard_cards` onto the CSS grid, provides card CRUD, drag-and-drop
 * asset pinning, resizing, and change-triggered reactivity.
 * Fully vectorized with zero emojis.
 */

import { getEventStream } from './harness.js';
import {
  listCards, addCard, updateCard, removeCard,
  runCardSql, affectedCards,
  computeGridRows, sanitizeCardLayout, GRID_COLS, CARD_ROW_CAP,
} from './grid.js';
import { queryAll, execParams } from './schema.js';
import { materializeToolResult } from './materialize.js';
import { SqlAutocompleteController } from './sql-autocomplete.js';
import { icon, ICONS } from './icons.js';

let agent = null;
let busy = false;
let pendingTables = new Set();
let flushTimer = null;
let streamAttached = false;
let editingCardId = null; // null = add mode
let cardSqlAutocomplete = null;

// ── Init ──────────────────────────────────────────────────────────────

export function initGridUi(agentHandle) {
  agent = agentHandle;
  attachStream();

  const cardSqlEl = document.getElementById('card-sql');
  if (cardSqlEl && !cardSqlAutocomplete) {
    cardSqlAutocomplete = new SqlAutocompleteController(cardSqlEl, {
      alwaysSuggest: true,
    });
  }

  document.getElementById('btn-add-card')?.addEventListener('click', () => openCardDialog('add'));
  document.getElementById('btn-refresh-all')?.addEventListener('click', () => {
    refreshAllCards().catch(e => console.warn('[grid-ui] refresh-all failed:', e));
  });
  document.getElementById('card-cancel')?.addEventListener('click', closeCardDialog);
  document.getElementById('card-dialog-close')?.addEventListener('click', closeCardDialog);
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

let activeDragData = null;
let lastHoverKey = '';

/** Clear all drag-target highlights and preview outlines */
function clearDropHighlights() {
  lastHoverKey = '';
  document.querySelectorAll('.grid-cell.drag-target-hover, .grid-cell.drag-target-invalid').forEach(el => {
    el.classList.remove('drag-target-hover', 'drag-target-invalid');
  });
}

/** Highlight all cells that will be covered by the drop target span */
function highlightDropSpan(startRow, startCol, colSpan = 1, rowSpan = 1) {
  document.querySelectorAll('.grid-cell.drag-target-hover, .grid-cell.drag-target-invalid').forEach(el => {
    el.classList.remove('drag-target-hover', 'drag-target-invalid');
  });
  const isValidCol = startCol + colSpan <= GRID_COLS;
  for (let r = startRow; r < startRow + rowSpan; r++) {
    for (let c = startCol; c < startCol + colSpan; c++) {
      const cell = document.querySelector(`.grid-cell[data-row="${r}"][data-col="${c}"]`);
      if (cell) {
        if (!isValidCol) {
          cell.classList.add('drag-target-invalid');
        } else {
          cell.classList.add('drag-target-hover');
        }
      }
    }
  }
}

/** Compute and render drop highlights for move or resize (with hover-key deduplication) */
function updateDragHighlight(hoverRow, hoverCol) {
  if (!activeDragData) {
    clearDropHighlights();
    return;
  }
  const key = `${hoverRow}:${hoverCol}:${activeDragData.type}:${activeDragData.cardId || activeDragData.title}:${activeDragData.colSpan}:${activeDragData.rowSpan}`;
  if (key === lastHoverKey) return;
  lastHoverKey = key;

  if (activeDragData.type === 'resize_card') {
    const startRow = activeDragData.startRow ?? 0;
    const startCol = activeDragData.startCol ?? 0;
    const newColSpan = Math.max(1, Math.min(GRID_COLS - startCol, hoverCol - startCol + 1));
    const newRowSpan = Math.max(1, hoverRow - startRow + 1);
    highlightDropSpan(startRow, startCol, newColSpan, newRowSpan);
  } else {
    const cs = activeDragData.colSpan || 1;
    const rs = activeDragData.rowSpan || 1;
    const startCol = Math.max(0, Math.min(hoverCol, GRID_COLS - cs));
    highlightDropSpan(hoverRow, startCol, cs, rs);
  }
}

/** Full grid re-render from the DB (boot, after CRUD, after cartridge import). */
export async function renderGrid({ forceRefresh = false } = {}) {
  if (!agent) return;
  const grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  let cards = await listCards(agent.sqlite3, agent.db);
  // Auto-heal any invalid or overlapping cards
  const heals = sanitizeCardLayout(cards);
  if (heals.length > 0) {
    for (const h of heals) {
      await execParams(agent.sqlite3, agent.db,
        `UPDATE dashboard_cards SET row = ?, col = ?, row_span = ?, col_span = ? WHERE id = ?`,
        [h.row, h.col, h.row_span, h.col_span, h.id]);
    }
    cards = await listCards(agent.sqlite3, agent.db);
  }

  const totalRows = computeGridRows(cards);
  grid.style.gridTemplateRows = `repeat(${totalRows}, minmax(160px, auto))`;

  // Preserve existing rendered card DOM elements to prevent re-querying SQL on move/resize
  const existingCards = new Map();
  grid.querySelectorAll('.dash-card').forEach(el => {
    const cid = parseInt(el.dataset.cardId, 10);
    if (!isNaN(cid)) existingCards.set(cid, el);
  });

  // Re-create background drop-cells
  grid.innerHTML = '';
  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.style.gridRow = `${r + 1} / span 1`;
      cell.style.gridColumn = `${c + 1} / span 1`;

      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        updateDragHighlight(r, c);
      });
      cell.addEventListener('dragleave', (e) => {
        if (!cell.contains(e.relatedTarget)) {
          clearDropHighlights();
        }
      });
      cell.addEventListener('drop', (e) => onCellDrop(e, cell));

      grid.appendChild(cell);
    }
  }

  // Unified grid container dragover/drop handling
  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cell = document.elementsFromPoint(e.clientX, e.clientY).find(el => el.classList?.contains('grid-cell'));
    if (cell) {
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      updateDragHighlight(r, c);
    }
  });

  grid.addEventListener('dragleave', (e) => {
    if (!grid.contains(e.relatedTarget)) {
      clearDropHighlights();
    }
  });

  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    const cell = document.elementsFromPoint(e.clientX, e.clientY).find(el => el.classList?.contains('grid-cell'));
    if (cell) {
      onCellDrop(e, cell);
    } else {
      clearDropHighlights();
    }
  });

  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'grid-empty';
    empty.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; gap: 0.5rem;">
        <div style="color: var(--text-muted); opacity: 0.7;">
          ${ICONS.dashboard({ size: 32 })}
        </div>
        <div style="font-weight: 500; color: var(--text-primary);">Dashboard Canvas is Empty</div>
        <div style="font-size: 0.72rem; color: var(--text-muted); max-width: 260px; line-height: 1.4;">
          Drag query results or web searches from chat, or click <strong>[card]</strong> to pin live SQL views.
        </div>
      </div>
    `;
    grid.appendChild(empty);
    return;
  }

  // Append cards: reuse existing element geometry if already rendered
  for (const card of cards) {
    let el = existingCards.get(card.id);
    if (el) {
      // Reposition instantly in CSS Grid
      el.style.gridRow = `${card.row + 1} / span ${card.row_span}`;
      el.style.gridColumn = `${card.col + 1} / span ${card.col_span}`;
      const titleEl = el.querySelector('.dash-card-title');
      if (titleEl && titleEl.textContent !== card.title) titleEl.textContent = card.title;
      const cycleBtn = el.querySelector('.card-cycle-size');
      if (cycleBtn) cycleBtn.title = `Cycle card size (${card.col_span}x${card.row_span})`;
      grid.appendChild(el);
      if (forceRefresh) {
        await refreshCard(card.id, { card });
      }
    } else {
      // New card added
      el = buildCardEl(card);
      grid.appendChild(el);
      await refreshCard(card.id, { card });
    }
  }
}

/** Handle dropping an asset or moving a card onto a grid cell. */
async function onCellDrop(e, cell) {
  e.preventDefault();
  clearDropHighlights();
  document.getElementById('dashboard-grid')?.classList.remove('is-dragging');
  if (busy || !agent) return;

  const targetRow = parseInt(cell.dataset.row, 10);
  const targetCol = parseInt(cell.dataset.col, 10);
  if (isNaN(targetRow) || isNaN(targetCol)) return;

  let rawData = e.dataTransfer.getData('application/json');
  let data = activeDragData;
  if (!data && rawData) {
    try { data = JSON.parse(rawData); } catch {}
  }
  if (!data) return;

  try {
    if (data.type === 'move_card') {
      const colSpan = Number(data.colSpan || 1);
      const rowSpan = Number(data.rowSpan || 1);
      const validCol = Math.max(0, Math.min(targetCol, GRID_COLS - colSpan));
      await updateCard(agent.sqlite3, agent.db, data.cardId, {
        row: targetRow,
        col: validCol,
        rowSpan,
        colSpan,
      }, { reflow: true });
      await renderGrid();
    } else if (data.type === 'resize_card') {
      const origCard = (await listCards(agent.sqlite3, agent.db)).find(c => c.id === data.cardId);
      if (origCard) {
        const newColSpan = Math.max(1, Math.min(GRID_COLS - origCard.col, targetCol - origCard.col + 1));
        const newRowSpan = Math.max(1, targetRow - origCard.row + 1);
        await updateCard(agent.sqlite3, agent.db, data.cardId, {
          colSpan: newColSpan,
          rowSpan: newRowSpan,
        }, { reflow: true });
        await renderGrid();
      }
    } else if (data.type === 'table') {
      let sql = data.sql;
      if (!sql && data.toolCallId) {
        const rows = await queryAll(agent.sqlite3, agent.db,
          `SELECT content FROM messages WHERE role = 'assistant' AND tool_calls LIKE ? ORDER BY id DESC LIMIT 1`,
          [`%${data.toolCallId}%`]);
        if (rows.length) {
          try {
            const p = JSON.parse(rows[0][0]);
            const tc = (p.tool_calls || []).find(t => t.id === data.toolCallId);
            if (tc?.function?.arguments) {
              const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
              if (args.query || args.sql) sql = args.query || args.sql;
            }
          } catch {}
        }
      }
      if (!sql) sql = 'SELECT 1 AS status';
      await addCard(agent.sqlite3, agent.db, {
        title: data.title || 'Table Query',
        sql,
        row: targetRow,
        col: Math.min(targetCol, GRID_COLS - 1),
        rowSpan: 1,
        colSpan: 1,
        reflow: true,
      });
      await renderGrid();
    } else if (data.type === 'search_web' || data.type === 'fetch_url') {
      const baseName = data.type === 'search_web' ? 'web_search' : 'page_fetch';
      const cleanName = `${baseName}_${Date.now().toString(36).slice(-4)}`;
      const mat = await materializeToolResult(agent.sqlite3, agent.db, {
        tableName: cleanName,
        toolCallId: data.toolCallId || null,
        rawContent: data.rawPayload || null,
      });
      if (mat.error) {
        console.warn('[grid-ui] materialize error:', mat.error);
        return;
      }
      const span = Math.min(2, GRID_COLS - targetCol);
      await addCard(agent.sqlite3, agent.db, {
        title: data.title || mat.table,
        sql: `SELECT * FROM "${mat.table}"`,
        row: targetRow,
        col: Math.min(targetCol, GRID_COLS - span),
        rowSpan: 1,
        colSpan: span,
        reflow: true,
      });
      await renderGrid();
    }
  } catch (err) {
    console.warn('[grid-ui] drop error (recovering):', err);
    await renderGrid();
  } finally {
    activeDragData = null;
  }
}

/** Rebuild the whole grid + explorer (cartridge import replaced the DB). */
export async function rebuildGrid() {
  if (!agent) return;
  pendingTables.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await renderGrid();
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
  let card = knownCard;
  if (!card) {
    const cards = await listCards(agent.sqlite3, agent.db);
    card = cards.find(c => c.id === id);
  }
  if (!card) { el.remove(); return; }

  const res = await runCardSql(agent.sqlite3, agent.db, card.sql);
  renderCardBody(el, card, res);

  const footer = el.querySelector('.dash-card-footer');
  if (footer) {
    const stamp = new Date().toLocaleTimeString();
    footer.textContent = `updated ${stamp} · ${res.ms} ms` + (live ? ' · live' : '');
  }
  if (live) {
    el.classList.remove('card-live-flash');
    void el.offsetWidth;
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
    <header class="dash-card-header" draggable="true" title="Drag to move card">
      <span class="dash-card-drag-handle" title="Drag to move">
        ${ICONS.gripDots({ size: 14 })}
      </span>
      <span class="dash-card-title"></span>
      <div class="dash-card-actions">
        <button type="button" class="card-btn card-cycle-size" title="Cycle card size (${card.col_span}x${card.row_span})">
          ${ICONS.expand({ size: 12 })}
        </button>
        <button type="button" class="card-btn card-refresh" title="Refresh card">
          ${ICONS.refresh({ size: 12 })}
        </button>
        <button type="button" class="card-btn card-edit" title="Edit card">
          ${ICONS.edit({ size: 12 })}
        </button>
        <button type="button" class="card-btn card-delete" title="Delete card">
          ${ICONS.close({ size: 12 })}
        </button>
      </div>
    </header>
    <div class="dash-card-body"><em class="card-loading" style="color: var(--text-muted); font-size: 0.72rem;">running…</em></div>
    <footer class="dash-card-footer"></footer>
    <div class="card-resize-handle" draggable="true" title="Drag to resize card">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v6h-6"></path>
        <path d="M21 9v2h-2"></path>
        <path d="M9 21h2v-2"></path>
      </svg>
    </div>`;

  el.querySelector('.dash-card-title').textContent = card.title;

  // Header drag-start to move card
  const header = el.querySelector('.dash-card-header');
  header.addEventListener('dragstart', (e) => {
    activeDragData = {
      type: 'move_card',
      cardId: card.id,
      colSpan: card.col_span,
      rowSpan: card.row_span,
    };
    e.dataTransfer.setData('application/json', JSON.stringify(activeDragData));
    e.dataTransfer.effectAllowed = 'move';
    document.getElementById('dashboard-grid')?.classList.add('is-dragging');
    el.classList.add('is-being-dragged');
  });

  header.addEventListener('dragend', () => {
    activeDragData = null;
    document.getElementById('dashboard-grid')?.classList.remove('is-dragging');
    el.classList.remove('is-being-dragged');
    clearDropHighlights();
  });

  // Resize handle drag-start
  const resizeHandle = el.querySelector('.card-resize-handle');
  resizeHandle.addEventListener('dragstart', (e) => {
    activeDragData = {
      type: 'resize_card',
      cardId: card.id,
      startRow: card.row,
      startCol: card.col,
      colSpan: card.col_span,
      rowSpan: card.row_span,
    };
    e.dataTransfer.setData('application/json', JSON.stringify(activeDragData));
    e.dataTransfer.effectAllowed = 'move';
    document.getElementById('dashboard-grid')?.classList.add('is-dragging');
    el.classList.add('is-being-dragged');
  });

  resizeHandle.addEventListener('dragend', () => {
    activeDragData = null;
    document.getElementById('dashboard-grid')?.classList.remove('is-dragging');
    el.classList.remove('is-being-dragged');
    clearDropHighlights();
  });

  // Cycle size button
  el.querySelector('.card-cycle-size').addEventListener('click', async () => {
    if (busy || !agent) return;
    const sizes = [
      { cs: 1, rs: 1 },
      { cs: 2, rs: 1 },
      { cs: 3, rs: 1 },
      { cs: 2, rs: 2 },
      { cs: 3, rs: 2 },
    ];
    let nextIdx = 0;
    const currIdx = sizes.findIndex(s => s.cs === card.col_span && s.rs === card.row_span);
    if (currIdx >= 0) nextIdx = (currIdx + 1) % sizes.length;
    const targetSize = sizes[nextIdx];
    const targetCol = Math.min(card.col, GRID_COLS - targetSize.cs);
    try {
      await updateCard(agent.sqlite3, agent.db, card.id, {
        col: targetCol,
        colSpan: targetSize.cs,
        rowSpan: targetSize.rs,
      }, { reflow: true });
      await renderGrid();
    } catch (err) {
      console.warn('[grid-ui] cycle size failed:', err);
    }
  });

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
    err.style.cssText = 'padding: 0.4rem 0.6rem; color: var(--red); display: flex; align-items: center; gap: 0.35rem; font-size: 0.72rem;';
    err.innerHTML = `${ICONS.alertTriangle({ size: 14 })} <span>${escapeHtml(res.error)}</span>`;
    body.appendChild(err);
    return;
  }

  // 1×1 result → big metric; anything else → table.
  if (res.values.length === 1 && res.columns.length === 1) {
    const metricWrap = document.createElement('div');
    metricWrap.className = 'card-metric';
    
    const metricVal = document.createElement('div');
    metricVal.className = 'metric-value';
    metricVal.textContent = String(res.values[0][0] ?? 'NULL');
    
    const label = document.createElement('div');
    label.className = 'metric-label';
    label.textContent = res.columns[0];
    
    metricWrap.appendChild(metricVal);
    metricWrap.appendChild(label);
    body.appendChild(metricWrap);
    return;
  }

  if (!res.values.length) {
    body.innerHTML = '<em class="card-empty" style="color: var(--text-muted); font-size: 0.72rem; display: block; text-align: center; padding: 1rem 0;">(no rows returned)</em>';
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
    note.style.cssText = 'font-size: 0.65rem; color: var(--text-muted); font-style: italic; margin-top: 0.25rem;';
    note.textContent = `… truncated at ${CARD_ROW_CAP} rows`;
    body.appendChild(note);
  }
}

// ── Card CRUD ─────────────────────────────────────────────────────────

async function deleteCard(card) {
  if (!agent || busy) return;
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
    mode === 'edit' ? 'Edit Dashboard Card' : 'New Dashboard Card';
  document.getElementById('card-title').value = card ? card.title : '';
  document.getElementById('card-sql').value = card ? card.sql : '';
  document.getElementById('card-row').value = String(card ? card.row : 0);
  document.getElementById('card-col').value = String(card ? card.col : 0);
  document.getElementById('card-row-span').value = String(card ? card.row_span : 1);
  document.getElementById('card-col-span').value = String(card ? card.col_span : 1);
  // Position is explicit in edit mode; add mode auto-packs the first fitting spot.
  document.getElementById('card-placement-row').classList.toggle('hidden', mode !== 'edit');
  document.getElementById('card-submit').textContent = mode === 'edit' ? 'Save Card' : 'Add Card';
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
  if (!agent || busy) return;
  const title = document.getElementById('card-title').value;
  const sql = document.getElementById('card-sql').value;
  const row = Number(document.getElementById('card-row').value);
  const col = Number(document.getElementById('card-col').value);
  const rowSpan = Number(document.getElementById('card-row-span').value);
  const colSpan = Number(document.getElementById('card-col-span').value);

  try {
    if (editingCardId == null) {
      // Add: auto-pack the first fitting spot
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
