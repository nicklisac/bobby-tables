/**
 * DOCUMENTS UI (T16) — left-pane accordion: the FTS5 document corpus.
 *
 * Search box runs the SAME FTS5 MATCH the agent's search_documents tool
 * runs (empty box = newest-first listing). Add form stores a 'user'
 * document; delete removes it (the FTS5 sync trigger drops the postings).
 * Refreshes on boot, on add/delete, and at the end of every turn (the
 * `done` event — fetch_url / search_web auto-ingest lands mid-turn, and a
 * refresh there would re-enter wasm inside the parked cascade fiber; at
 * `done` the savepoint is released and the connection is quiescent).
 */

import { escapeHtml } from './utils.js';
import { ICONS } from './icons.js';
import {
  upsertDocument, searchDocuments, listDocuments, deleteDocument, getDocumentCount,
} from './documents.js';

// ── Init context (wired once by main.js at boot) ─────────────────────

let ctx = null;
let searchTimer = null;
let refreshing = false;

/**
 * @param {object} context
 * @param {() => object} context.getAgent - live agent handle (null pre-boot)
 */
export function initDocumentsUi(context) {
  // Re-boot guard: bootAgent() can run again (e.g. after a settings change).
  // Re-attach nothing — just refresh the context and re-render, so we never
  // stack duplicate DOM listeners or event-stream readers.
  if (ctx) {
    ctx = context;
    renderDocuments();
    return;
  }
  ctx = context;

  const input = document.getElementById('documents-search-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { renderDocuments(); }, 250);
    });
  }

  document.getElementById('btn-new-document')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddForm(true);
  });
  document.getElementById('btn-document-add')?.addEventListener('click', addDocument);
  document.getElementById('btn-document-cancel')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddForm(false);
  });
  document.getElementById('documents-list')?.addEventListener('click', onListClick);

  // End-of-turn refresh (auto-ingest side effects from fetch_url / search_web,
  // or an agent ingest_document call, may have changed the corpus).
  const agent = ctx.getAgent();
  if (agent?.eventStream) {
    const reader = agent.eventStream.getStream().getReader();
    (async () => {
      try {
        for (;;) {
          const { value } = await reader.read();
          if (value?.type === 'done') renderDocuments();
        }
      } catch { /* stream closed */ }
    })();
  }

  renderDocuments();
}

function toggleAddForm(show) {
  const form = document.getElementById('document-add-form');
  if (!form) return;
  form.classList.toggle('hidden', !show);
  if (show) document.getElementById('document-add-title')?.focus();
}

async function addDocument() {
  const agent = ctx.getAgent();
  if (!agent) return;
  const title = document.getElementById('document-add-title')?.value.trim();
  const content = document.getElementById('document-add-content')?.value.trim();
  if (!title || !content) return;
  const btn = document.getElementById('btn-document-add');
  if (btn) btn.disabled = true;
  try {
    await upsertDocument(agent.sqlite3, agent.db, { source: 'user', title, content });
    document.getElementById('document-add-title').value = '';
    document.getElementById('document-add-content').value = '';
    toggleAddForm(false);
    await renderDocuments();
  } catch (e) {
    console.error('[documents-ui] add failed:', e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onListClick(e) {
  const delBtn = e.target.closest('.btn-document-delete');
  if (!delBtn) return;
  e.stopPropagation();
  const agent = ctx.getAgent();
  if (!agent) return;
  const id = Number(delBtn.closest('.document-item')?.dataset.docId);
  if (!Number.isFinite(id)) return;
  const title = delBtn.closest('.document-item')?.querySelector('.document-item-title')?.textContent || `#${id}`;
  if (!confirm(`Delete document "${title}" from the search corpus?`)) return;
  try {
    await deleteDocument(agent.sqlite3, agent.db, id);
    await renderDocuments();
  } catch (err) {
    console.error('[documents-ui] delete failed:', err);
  }
}

const SOURCE_BADGES = {
  'web-fetch': { label: 'fetch', title: 'Fetched web page (auto-ingested by fetch_url)' },
  'web-search': { label: 'search', title: 'Web search result (auto-ingested by search_web)' },
  'user': { label: 'note', title: 'Stored via ingest_document or the Documents panel' },
};

async function renderDocuments() {
  const agent = ctx?.getAgent();
  if (!agent || refreshing) return;
  refreshing = true;
  try {
    const { sqlite3, db } = agent;
    const listEl = document.getElementById('documents-list');
    const countEl = document.getElementById('documents-count');
    if (!listEl) return;

    const q = (document.getElementById('documents-search-input')?.value || '').trim();
    const count = await getDocumentCount(sqlite3, db);
    if (countEl) countEl.textContent = String(count);

    if (!q) {
      const docs = await listDocuments(sqlite3, db, { limit: 200 });
      if (!docs.length) {
        listEl.innerHTML = '<div class="explorer-empty" style="padding: 0.5rem; font-size: 0.7rem; color: var(--text-muted);">No documents yet — fetched pages, search results, and added notes land here.</div>';
        return;
      }
      listEl.innerHTML = docs.map(d => {
        const badge = SOURCE_BADGES[d.source] || { label: d.source, title: d.source };
        const preview = d.content.length > 120 ? d.content.slice(0, 120) + '…' : d.content;
        return `
          <div class="document-item" data-doc-id="${d.id}">
            <div class="document-item-main">
              <span class="document-source-badge document-source-${escapeHtml(d.source)}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span>
              <div class="document-item-text">
                <div class="document-item-title" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</div>
                <div class="document-item-meta" title="${escapeHtml(preview)}">${escapeHtml(d.sourceRef || '')}${d.sourceRef ? ' · ' : ''}${escapeHtml(d.createdAt || '')} · ${d.content.length} chars</div>
              </div>
            </div>
            <button type="button" class="btn-document-delete" title="Delete document">${ICONS.close({ size: 11 })}</button>
          </div>
        `;
      }).join('');
      return;
    }

    // Live FTS5 preview — the same MATCH the agent's tool runs.
    try {
      const hits = await searchDocuments(sqlite3, db, q, 50);
      if (!hits.length) {
        listEl.innerHTML = `<div class="explorer-empty" style="padding: 0.5rem; font-size: 0.7rem; color: var(--text-muted);">No matches for "${escapeHtml(q)}"</div>`;
        return;
      }
      listEl.innerHTML = hits.map(d => {
        const badge = SOURCE_BADGES[d.source] || { label: d.source, title: d.source };
        return `
          <div class="document-item" data-doc-id="${d.id}">
            <div class="document-item-main">
              <span class="document-source-badge document-source-${escapeHtml(d.source)}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span>
              <div class="document-item-text">
                <div class="document-item-title" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</div>
                <div class="document-item-meta" title="${escapeHtml(d.snippet)}">${escapeHtml(d.snippet)}</div>
              </div>
            </div>
            <button type="button" class="btn-document-delete" title="Delete document">${ICONS.close({ size: 11 })}</button>
          </div>
        `;
      }).join('');
    } catch (e) {
      listEl.innerHTML = `<div class="explorer-empty" style="padding: 0.5rem; font-size: 0.7rem; color: var(--text-muted);">Search error: ${escapeHtml(e.message)}</div>`;
    }
  } finally {
    refreshing = false;
  }
}
