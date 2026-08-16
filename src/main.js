/**
 * MAIN — Entry point. One INSERT triggers the pure-SQL ReAct cascade.
 *
 * Session-aware: messages are partitioned by session_id.
 * UI supports session switching, creation, and deletion.
 * Live Event Streaming: renders tokens, tool execution indicators, and results in real time.
 */

import { bootSqliteAgent, getEventStream, beginTurn, requestStop, endTurn, isStopRequested } from './harness.js';
import {
  setActiveSession, createSession, renameSession, listSessions, deleteSession, getSessionTokenUsage,
  sweepCaptureTriggers, repairOrphanedToolCalls, evictChangesets, setSuppressCascade,
  setSuppressCapture, ensureCaptureTriggers, setCurrentTurnId,
  getRewindableScratchpadTurns, queryAll, quoteIdent, logDDL, execParams,
  isProtectedTable, extractTargetTables, assertProtectedTablesInvariant,
} from './schema.js';
import {
  runCompaction, estimateActiveContextTokens, resolveContextWindow,
  COMPACTION_THRESHOLD, FALLBACK_WINDOW,
} from './compaction.js';
import {
  rewindToBeforeTurn, getChangesetSummary,
  rewindToBeforeScratchpadTurn, getScratchpadChangesetSummary,
} from './rewind.js';
import { exportCartridge, importCartridge, exportSqlDump } from './cartridge.js';
import { ingestCsvToSqlite } from './csv-ingestion.js';
import * as gridUi from './grid-ui.js';
import * as gridEngine from './grid.js';
import * as explorerEngine from './explorer.js';
import * as explorerUi from './explorer-ui.js';
import { initPaneResizers } from './panes.js';
import { SqlAutocompleteController, globalSchemaIndex, detectBangMode } from './sql-autocomplete.js';
import { SQLITE_ROW, SQLITE_DONE } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
import './styles.css';

const messagesEl        = document.getElementById('messages');
const loadingEl         = document.getElementById('loading');
const formEl            = document.getElementById('input-form');
const inputEl           = document.getElementById('user-input');
const sendBtn           = document.getElementById('send-btn');
const statusBar         = document.getElementById('status-bar');
const bangBadge         = document.getElementById('bang-badge');
const configForm        = document.getElementById('config-form');
const configProvider    = document.getElementById('config-provider');
const rowConfigUrl      = document.getElementById('row-config-url');
const configUrl         = document.getElementById('config-url');
const configModel       = document.getElementById('config-model');
const configKey         = document.getElementById('config-key');
const labelConfigKey    = document.getElementById('label-config-key');
const configContextWindow = document.getElementById('config-context-window');
const chatContainer     = document.getElementById('chat-container');
const dragOverlay       = document.getElementById('drag-overlay');
const ingestionProgress = document.getElementById('ingestion-progress');
const progressTitle     = document.getElementById('progress-title');
const progressCount     = document.getElementById('progress-count');
const progressBarFill   = document.getElementById('progress-bar-fill');
const btnUploadCsv      = document.getElementById('btn-upload-csv');
const csvFileInput      = document.getElementById('csv-file-input');
const btnToggleConfig   = document.getElementById('btn-toggle-config');
const configModal       = document.getElementById('config-modal');
const configCancel      = document.getElementById('config-cancel');
const configCloseBtn    = document.getElementById('config-close-btn');

let agent = null;
let isProcessing = false;
let activeSessionId = 'default';

// Active streaming UI elements
let activeStreamingBubble = null;
let activeToolIndicator = null;
let isStreamListenerAttached = false;

// ── Config Persistence ──────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(localStorage.getItem('sql-agent-config') || '{}'); } catch { return {}; }
}

function saveConfig(c) {
  localStorage.setItem('sql-agent-config', JSON.stringify(c));
}

function updateConfigVisibility(provider) {
  const isGemini = provider === 'gemini';
  if (rowConfigUrl) rowConfigUrl.style.display = isGemini ? 'none' : 'flex';
  if (labelConfigKey) {
    labelConfigKey.innerHTML = isGemini
      ? 'API Key <span class="required">(required for Gemini API)</span>'
      : 'API Key <span class="optional">(optional for local Ollama/LM Studio)</span>';
  }
  if (isGemini) {
    configModel.placeholder = 'gemini-2.5-flash';
    configKey.placeholder = 'AIza...';
  } else {
    configUrl.placeholder = 'http://localhost:11434/v1';
    configModel.placeholder = 'llama3.2';
    configKey.placeholder = 'AIza... or sk-...';
  }
}

function populateConfigForm() {
  const c = loadConfig();
  if (c.provider) configProvider.value = c.provider;
  if (c.url !== undefined) configUrl.value = c.url;
  if (c.model !== undefined) configModel.value = c.model;
  if (c.apiKey !== undefined) configKey.value = c.apiKey;
  if (c.contextWindow !== undefined) configContextWindow.value = c.contextWindow;
  updateConfigVisibility(configProvider.value);
}

function openConfigModal() {
  populateConfigForm();
  if (configModal) configModal.classList.remove('hidden');
  if (btnToggleConfig) btnToggleConfig.classList.add('is-active');
  setTimeout(() => configModel?.focus(), 50);
}

function closeConfigModal() {
  if (configModal) configModal.classList.add('hidden');
  if (btnToggleConfig) btnToggleConfig.classList.remove('is-active');
}

if (configProvider) {
  configProvider.addEventListener('change', (e) => {
    updateConfigVisibility(e.target.value);
  });
}

if (btnToggleConfig) {
  btnToggleConfig.addEventListener('click', () => {
    if (configModal && !configModal.classList.contains('hidden')) {
      closeConfigModal();
    } else {
      openConfigModal();
    }
  });
}

if (configCancel) configCancel.addEventListener('click', closeConfigModal);
if (configCloseBtn) configCloseBtn.addEventListener('click', closeConfigModal);

if (configModal) {
  configModal.addEventListener('click', (e) => {
    if (e.target === configModal) closeConfigModal();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && configModal && !configModal.classList.contains('hidden')) {
    closeConfigModal();
  }
});

if (configForm) {
  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveConfig({
      provider: configProvider.value,
      url: configUrl.value.trim(),
      model: configModel.value.trim(),
      apiKey: configKey.value.trim(),
      contextWindow: configContextWindow.value.trim(),
    });
    closeConfigModal();
    statusBar.textContent = 'Configuration saved. Rebooting…';
    await bootAgent();
  });
}

// ── Session Management (Left Pane Double Accordion) ──────────────────

async function populateSessionDropdown() {
  if (!agent) return;
  const sessions = await listSessions(agent.sqlite3, agent.db);

  const sessionListEl = document.getElementById('session-list');
  if (sessionListEl) {
    sessionListEl.innerHTML = '';
    if (!sessions.length) {
      sessionListEl.innerHTML = '<div class="explorer-empty" style="padding: 0.5rem; font-size: 0.7rem; color: var(--text-muted);">No sessions</div>';
    } else {
      sessions.forEach(s => {
        const item = document.createElement('div');
        const isActive = (s.id === activeSessionId);
        const displayName = (s.name && s.name.trim()) ? s.name.trim() : (s.id === 'default' ? 'Default Session' : s.id);
        item.className = `session-item ${isActive ? 'active' : ''}`;
        item.dataset.sessionId = s.id;
        item.dataset.sessionName = displayName;
        item.innerHTML = `
          <div class="session-item-main" title="${escapeHtml(displayName)} [${escapeHtml(s.id)}] (double-click to rename)">
            <span class="session-item-icon">${isActive ? '●' : '○'}</span>
            <span class="session-item-name">${escapeHtml(displayName)}</span>
          </div>
          <div class="session-item-actions">
            <button type="button" class="btn-session-item-action btn-session-item-rename" data-session-id="${escapeHtml(s.id)}" data-session-name="${escapeHtml(displayName)}" title="Rename session">✎</button>
            ${s.id !== 'default' ? `<button type="button" class="btn-session-item-action btn-session-item-delete" data-session-id="${escapeHtml(s.id)}" data-session-name="${escapeHtml(displayName)}" title="Delete session">✕</button>` : ''}
          </div>
        `;
        sessionListEl.appendChild(item);
      });
    }
  }
}

// ── Left Pane Double Accordion & Session Handlers ───────────────────

document.querySelectorAll('.accordion-header').forEach(header => {
  header.addEventListener('click', (e) => {
    if (e.target.closest('button, input, select')) return;
    const section = header.closest('.accordion-section');
    if (!section) return;
    section.classList.toggle('is-open');
  });
});

document.getElementById('btn-new-session')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!agent) return;
  const name = prompt('Session name:', 'New Session');
  if (!name?.trim()) return;
  const id = await createSession(agent.sqlite3, agent.db, name.trim());
  activeSessionId = id;
  activeStreamingBubble = null;
  activeToolIndicator = null;
  await setActiveSession(agent.sqlite3, agent.db, id);
  await populateSessionDropdown();
  await renderMessages();
});

document.getElementById('session-list')?.addEventListener('click', async (e) => {
  // 1. Rename session action
  const renameBtn = e.target.closest('.btn-session-item-rename');
  if (renameBtn) {
    e.stopPropagation();
    const id = renameBtn.dataset.sessionId;
    const currName = renameBtn.dataset.sessionName || '';
    if (!id || !agent) return;
    const newName = prompt(`Rename session:`, currName);
    if (!newName?.trim() || newName.trim() === currName) return;
    try {
      await renameSession(agent.sqlite3, agent.db, id, newName.trim());
      await populateSessionDropdown();
    } catch (err) {
      alert(`Failed to rename session: ${err.message}`);
    }
    return;
  }

  // 2. Delete session action
  const deleteBtn = e.target.closest('.btn-session-item-delete');
  if (deleteBtn) {
    e.stopPropagation();
    const id = deleteBtn.dataset.sessionId;
    const name = deleteBtn.dataset.sessionName || id;
    if (id === 'default' || !agent) return;
    if (!confirm(`Delete session "${name}" and all its messages?`)) return;
    try {
      await deleteSession(agent.sqlite3, agent.db, id);
      if (activeSessionId === id) {
        activeSessionId = 'default';
        activeStreamingBubble = null;
        activeToolIndicator = null;
        await setActiveSession(agent.sqlite3, agent.db, 'default');
      }
      await populateSessionDropdown();
      await renderMessages();
    } catch (err) {
      alert(`Failed to delete session: ${err.message}`);
    }
    return;
  }

  // 3. Switch session action
  const item = e.target.closest('.session-item');
  if (!item || !agent) return;
  const id = item.dataset.sessionId;
  if (!id || id === activeSessionId) return;
  activeSessionId = id;
  activeStreamingBubble = null;
  activeToolIndicator = null;
  await setActiveSession(agent.sqlite3, agent.db, activeSessionId);
  await populateSessionDropdown();
  await renderMessages();
});

// Double-click session name to rename
document.getElementById('session-list')?.addEventListener('dblclick', async (e) => {
  const item = e.target.closest('.session-item');
  if (!item || !agent) return;
  const id = item.dataset.sessionId;
  const currName = item.dataset.sessionName || '';
  if (!id) return;
  const newName = prompt(`Rename session:`, currName);
  if (!newName?.trim() || newName.trim() === currName) return;
  try {
    await renameSession(agent.sqlite3, agent.db, id, newName.trim());
    await populateSessionDropdown();
  } catch (err) {
    alert(`Failed to rename session: ${err.message}`);
  }
});

// ── Scroll & Helpers ────────────────────────────────────────────────

function scrollChatToBottom() {
  const chatContainer = document.getElementById('chat-container');
  if (chatContainer) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTable(columns, values) {
  if (!values || !values.length) return '<em>(no rows)</em>';
  let html = '<table class="result-table"><thead><tr>';
  columns.forEach(c => html += `<th>${escapeHtml(c)}</th>`);
  html += '</tr></thead><tbody>';
  values.forEach(row => {
    html += '<tr>';
    row.forEach(val => html += `<td>${escapeHtml(String(val ?? 'NULL'))}</td>`);
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

function renderToolContent(content, toolCallId = null, querySql = '') {
  if (content === null || content === undefined || content === '') return '<em>[empty]</em>';
  let parsed = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return `<div class="tool-detail">${escapeHtml(content)}</div>`;
    }
  }

  // 1. SQL Result Table: array format from run_dynamic_sql: [{ columns: [...], values: [...] }]
  if (Array.isArray(parsed) && parsed[0]?.columns && parsed[0]?.values) {
    const rawSql = querySql || parsed[0]?.query || '';
    const isSelect = !rawSql || /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(rawSql);
    return `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-sql="${escapeHtml(rawSql)}" data-title="Query Result">
        <div class="chat-asset-actions">
          <div class="drag-pin-badge" title="Drag to Dashboard to pin as card">⠿ Drag to Dashboard</div>
          ${(rawSql && isSelect) ? `<button type="button" class="btn-save-view-chat" data-sql="${escapeHtml(rawSql)}" title="Save Query as View in database catalog">👁 Save as View</button>` : ''}
        </div>
        ${renderTable(parsed[0].columns, parsed[0].values)}
      </div>
    `;
  }

  // 1b. Single object table format: { columns: [...], values: [...] }
  if (parsed && parsed.columns && parsed.values) {
    const rawSql = querySql || parsed?.query || '';
    const isSelect = !rawSql || /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(rawSql);
    return `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-sql="${escapeHtml(rawSql)}" data-title="Query Result">
        <div class="chat-asset-actions">
          <div class="drag-pin-badge" title="Drag to Dashboard to pin as card">⠿ Drag to Dashboard</div>
          ${(rawSql && isSelect) ? `<button type="button" class="btn-save-view-chat" data-sql="${escapeHtml(rawSql)}" title="Save Query as View in database catalog">👁 Save as View</button>` : ''}
        </div>
        ${renderTable(parsed.columns, parsed.values)}
      </div>
    `;
  }

  // 2. Search web results: { query: '...', results: [{ title, url, snippet }] }
  if (parsed && Array.isArray(parsed.results)) {
    if (!parsed.results.length) return '<em>(no search results found)</em>';
    let html = `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="search_web" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-title="Search: ${escapeHtml(parsed.query || 'Results')}">
        <div class="drag-pin-badge" title="Drag to Dashboard to materialize & pin">⠿ Drag to Dashboard</div>
        <div class="search-results-list">`;
    parsed.results.forEach(r => {
      html += `
        <div class="search-result-item">
          <a class="search-result-title" href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title || r.url)}</a>
          <div class="search-result-snippet">${escapeHtml(r.snippet || '')}</div>
        </div>
      `;
    });
    html += '</div></div>';
    return html;
  }

  // 3. Fetch URL preview: { url, status, title, content }
  if (parsed && parsed.url && (parsed.content !== undefined || parsed.title !== undefined)) {
    let html = `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="fetch_url" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-title="Page: ${escapeHtml(parsed.title || parsed.url)}">
        <div class="drag-pin-badge" title="Drag to Dashboard to materialize & pin">⠿ Drag to Dashboard</div>
        <div class="fetch-url-preview">`;
    html += `<div class="fetch-url-title"><strong>${escapeHtml(parsed.title || 'Fetched Page')}</strong> &middot; <a href="${escapeHtml(parsed.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(parsed.url)}</a></div>`;
    if (parsed.content) {
      const preview = parsed.content.length > 600 ? parsed.content.slice(0, 600) + '…' : parsed.content;
      html += `<div class="fetch-url-body">${escapeHtml(preview)}</div>`;
    }
    html += '</div></div>';
    return html;
  }

  // 4. Materialize result: { materialized: true, table, columns, row_count, source }
  if (parsed && parsed.materialized === true) {
    const colList = (parsed.columns || []).map(c => `<code>${escapeHtml(c.name)}</code> <span style="opacity: 0.7; font-size: 0.85em;">${escapeHtml(c.type)}</span>`).join(', ');
    return `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-sql="SELECT * FROM &quot;${escapeHtml(parsed.table)}&quot;" data-title="${escapeHtml(parsed.table)}">
        <div class="drag-pin-badge" title="Drag to Dashboard to pin as card">⠿ Drag to Dashboard</div>
        <div class="materialize-preview" style="padding: 4px 0;">
          <div style="font-weight: 600; color: #58a6ff; margin-bottom: 4px;">✨ Materialized table <code>${escapeHtml(parsed.table)}</code> (${escapeHtml(String(parsed.row_count))} rows)</div>
          <div style="font-size: 0.88em; color: #8b949e;">Columns: ${colList}</div>
        </div>
      </div>
    `;
  }

  // 5. Tool error: { error: '...' }
  if (parsed && parsed.error) {
    return `<div class="tool-error">⚠ Tool Error: ${escapeHtml(parsed.error)}</div>`;
  }

  // 5. Generic object / array fallback
  if (typeof parsed === 'object') {
    return `<pre class="json-dump">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
  }

  return `<div class="tool-detail">${escapeHtml(String(parsed))}</div>`;
}

// ── T9: Scratchpad Rendering ────────────────────────────────────────
//
// Scratchpad result rows are assistant rows whose content is a JSON envelope:
//   { scratchpad: true, sql, bangs, results: [{columns, values, truncated}],
//     infos: [string], error?: string, ms }
// `bangs === 1`  → `!`  shared: the transcript is in the agent's LLM context.
// `bangs >= 2`   → `!!` private: the transcript is kept OUT of the agent's
//                  LLM context (messages.in_context = 0).

const SCRATCH_ROW_CAP = 200; // rows kept per result set (bounds LLM context)

function renderScratchpadResult(env) {
  const privateCmd = (env.bangs || 1) >= 2;
  const isSelect = /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(env.sql || '');
  let html = `<div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-sql="${escapeHtml(env.sql || '')}" data-title="${escapeHtml(env.sql?.slice(0, 40) || 'Scratchpad Query')}">` +
    `<div class="chat-asset-actions">` +
    `<div class="drag-pin-badge" title="Drag to Dashboard to pin as card">⠿ Drag to Dashboard</div>` +
    (isSelect ? `<button type="button" class="btn-save-view-chat" data-sql="${escapeHtml(env.sql || '')}" title="Save Query as View in database catalog">👁 Save as View</button>` : '') +
    `</div>` +
    `<div class="scratchpad-header">` +
    `<span class="scratchpad-badge" title="${privateCmd ? 'Private — not in agent context' : 'Shared — agent sees this in context'}">${privateCmd ? '💥' : '⚡'}</span>` +
    `<code class="scratchpad-sql" title="${escapeHtml(env.sql || '')}">${escapeHtml(env.sql || '')}</code>` +
    `</div>`;

  if (env.error) {
    html += `<div class="tool-error">⚠ ${escapeHtml(env.error)}</div>`;
  } else {
    for (const info of env.infos || []) {
      html += `<div class="scratchpad-info">${escapeHtml(info)}</div>`;
    }
    for (const r of env.results || []) {
      html += renderTable(r.columns, r.values);
      if (r.truncated) {
        html += `<div class="scratchpad-info scratchpad-truncated">… truncated at ${SCRATCH_ROW_CAP} rows</div>`;
      }
    }
    if (!(env.results || []).length && !(env.infos || []).length) {
      html += '<em>(no output)</em>';
    }
  }

  if (env.ms !== undefined) {
    html += `<div class="scratchpad-footer">${env.ms} ms</div>`;
  }
  html += `</div>`;
  return html;
}

// ── Message Rendering ───────────────────────────────────────────────

async function renderMessages() {
  if (!agent) return;
  const rows = [];
  for await (const stmt of agent.sqlite3.statements(
    agent.db,
    `SELECT id, role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC`
  )) {
    agent.sqlite3.bind_collection(stmt, [activeSessionId]);
    while (await agent.sqlite3.step(stmt) === SQLITE_ROW) {
      rows.push(agent.sqlite3.row(stmt));
    }
  }

  // Map tool_call_ids to query strings so tool result bubbles can offer "Save as View"
  const toolCallQueries = new Map();
  for (const [, role, , toolCallsJson] of rows) {
    if (role === 'assistant' && toolCallsJson) {
      try {
        const tcs = JSON.parse(toolCallsJson);
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            if (tc?.id && tc?.function?.arguments) {
              try {
                const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
                if (args?.query) toolCallQueries.set(tc.id, args.query);
              } catch { /* parse error */ }
            }
          }
        }
      } catch { /* json parse error */ }
    }
  }

  // T9: which scratchpad turns (negative ids) still have rewound-able
  // changesets / DDL log rows — decides which scratchpad bubbles get a ⟲.
  const rewindableScratchpad = new Set();
  try {
    for (const t of await getRewindableScratchpadTurns(agent.sqlite3, agent.db, activeSessionId)) {
      rewindableScratchpad.add(t);
    }
  } catch (e) {
    console.warn('[main] rewindable-scratchpad query failed (non-fatal):', e);
  }

  // T2: compaction watermarks — a subtle divider marks where the context was
  // compacted (rendered from the compactions table, not a messages row).
  const compactionWatermarks = new Set();
  try {
    for (const [wm] of await queryAll(agent.sqlite3, agent.db,
      `SELECT watermark_id FROM compactions WHERE session_id = ? ORDER BY watermark_id ASC`, [activeSessionId])) {
      compactionWatermarks.add(wm);
    }
  } catch (e) {
    console.warn('[main] compactions query failed (non-fatal):', e);
  }

  messagesEl.innerHTML = '';
  rows.forEach(([id, role, content, , toolCallId]) => {
    if (role === 'system') return;
    const div = document.createElement('div');
    div.className = `message ${role}`;
    // T9: scratchpad user rows (leading bangs) render in monospace.
    if (role === 'user' && /^!/.test(String(content))) div.classList.add('scratchpad');

    if (role === 'tool') {
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = '🔧 Tool Output';
      div.appendChild(label);

      const querySql = toolCallQueries.get(toolCallId) || '';
      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = renderToolContent(content, toolCallId, querySql);
      div.appendChild(contentDiv);
    } else {
      // T9: scratchpad result rows are assistant rows carrying a JSON
      // envelope — render the table, not the raw JSON.
      let env = null;
      if (role === 'assistant' && typeof content === 'string') {
        try {
          const p = JSON.parse(content);
          if (p && p.scratchpad === true) env = p;
        } catch { /* plain text */ }
      }
      if (env) {
        div.classList.add('scratchpad-result');
        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = renderScratchpadResult(env);
        div.appendChild(contentDiv);
      } else {
        div.textContent = content || '[empty]';
      }
    }

    // T3: per-bubble rewind button on user messages — "rewind the database to
    // before this message".
    // T9: scratchpad user rows (leading bangs) get a ⟲ only while their
    // negative turn still has recorded changes; single-bang read-only
    // commands that changed nothing get no button.
    if (role === 'user') {
      const bangs = (String(content).match(/^!+/) || [''])[0].length;
      let target = null;
      if (bangs === 0) {
        target = () => rewindToBefore(id);
      } else if (rewindableScratchpad.has(-id)) {
        target = () => rewindToBeforeScratchpad(id);
      }
      if (target) {
        const rewindBtn = document.createElement('button');
        rewindBtn.className = 'rewind-btn';
        rewindBtn.title = bangs === 0
          ? 'Rewind the database to the state before this message'
          : 'Rewind the database to the state before this scratchpad command';
        rewindBtn.textContent = '⟲';
        rewindBtn.addEventListener('click', target);
        div.appendChild(rewindBtn);
      }
    }

    messagesEl.appendChild(div);

    // T2: compaction divider at the watermark position (the summarized prefix
    // ends here; the visible tail starts at the next message).
    if (compactionWatermarks.has(id)) {
      const divider = document.createElement('div');
      divider.className = 'compaction-divider';
      divider.textContent = '— context compacted —';
      messagesEl.appendChild(divider);
    }
  });

  scrollChatToBottom();
  await updateTokenUsage();
  // T8: keep the left-pane DB Explorer current (tables, views, row counts, DDL).
  explorerUi.renderExplorer().catch(e => console.warn('[main] explorer render failed (non-fatal):', e));
}

async function updateTokenUsage() {
  if (!agent) return;
  const [promptTokens, completionTokens] = await getSessionTokenUsage(agent.sqlite3, agent.db, activeSessionId);
  const tokenEl = document.getElementById('token-usage');
  if (tokenEl) {
    tokenEl.textContent = `Tokens: ${promptTokens} in / ${completionTokens} out`;
  }
}

// ── Event Stream Handling ───────────────────────────────────────────

function handleAgentEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'thinking': {
      statusBar.textContent = '● Agent thinking…';
      statusBar.style.color = '#58a6ff';

      // Create initial assistant bubble with thinking dots if none exists
      if (!activeStreamingBubble) {
        activeStreamingBubble = document.createElement('div');
        activeStreamingBubble.className = 'message assistant streaming';
        activeStreamingBubble.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
        messagesEl.appendChild(activeStreamingBubble);
        scrollChatToBottom();
      }
      break;
    }

    case 'token': {
      if (!activeStreamingBubble) {
        activeStreamingBubble = document.createElement('div');
        activeStreamingBubble.className = 'message assistant streaming';
        messagesEl.appendChild(activeStreamingBubble);
      }
      activeStreamingBubble.classList.add('streaming');
      activeStreamingBubble.textContent = event.accumulated !== undefined ? event.accumulated : event.token;
      scrollChatToBottom();
      break;
    }

    case 'tool_call': {
      // Finalize assistant bubble before tool execution
      if (activeStreamingBubble) {
        activeStreamingBubble.classList.remove('streaming');
        // If it was just thinking dots or empty, remove it
        if (!activeStreamingBubble.textContent.trim() || activeStreamingBubble.querySelector('.thinking-dots')) {
          activeStreamingBubble.remove();
        }
        activeStreamingBubble = null;
      }

      // Show tool execution indicator
      if (!activeToolIndicator) {
        activeToolIndicator = document.createElement('div');
        activeToolIndicator.className = 'tool-indicator';
        const argStr = typeof event.arguments === 'object' && event.arguments !== null
          ? (event.arguments.query || event.arguments.url || JSON.stringify(event.arguments))
          : String(event.arguments || '');

        activeToolIndicator.innerHTML = `
          <div class="tool-indicator-header">
            <span class="tool-spinner"></span>
            <span>Executing <code>${escapeHtml(event.name || 'tool')}</code></span>
          </div>
          ${argStr ? `<div class="tool-detail">${escapeHtml(argStr)}</div>` : ''}
        `;
        messagesEl.appendChild(activeToolIndicator);
        scrollChatToBottom();
      }

      statusBar.textContent = `● Executing tool: ${event.name || 'tool'}…`;
      statusBar.style.color = '#d29922';
      break;
    }

    case 'tool_result': {
      // Remove tool execution indicator
      if (activeToolIndicator) {
        activeToolIndicator.remove();
        activeToolIndicator = null;
      }

      // Render tool result bubble immediately
      const div = document.createElement('div');
      div.className = 'message tool';
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = `🔧 Tool Output: ${event.tool || 'result'}`;
      div.appendChild(label);

      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = renderToolContent(event.result || (event.error ? { error: event.error } : {}), event.toolCallId || event.tool_call_id, event.query);
      div.appendChild(contentDiv);

      messagesEl.appendChild(div);
      scrollChatToBottom();

      statusBar.textContent = '● Received tool result, continuing…';
      statusBar.style.color = '#58a6ff';
      break;
    }

    case 'data_change': {
      if (agent?.sqlite3 && agent?.db) {
        globalSchemaIndex.refreshFromDb(agent.sqlite3, agent.db).catch(() => {});
      }
      break;
    }

    case 'react_step': {
      // Trigger cascade step recorded by update_hook
      break;
    }

    case 'done': {
      if (activeStreamingBubble) {
        activeStreamingBubble.classList.remove('streaming');
        activeStreamingBubble = null;
      }
      if (activeToolIndicator) {
        activeToolIndicator.remove();
        activeToolIndicator = null;
      }
      break;
    }

    case 'error': {
      if (activeStreamingBubble) {
        activeStreamingBubble.classList.remove('streaming');
        activeStreamingBubble = null;
      }
      if (activeToolIndicator) {
        activeToolIndicator.remove();
        activeToolIndicator = null;
      }
      statusBar.textContent = `⚠ ${event.error || 'Agent execution error'}`;
      statusBar.style.color = '#f85149';
      break;
    }
  }
}

function startEventStreamListener() {
  if (isStreamListenerAttached) return;
  isStreamListenerAttached = true;

  const stream = getEventStream();
  const reader = stream.getReader();

  (async () => {
    try {
      while (true) {
        const { done, value: event } = await reader.read();
        if (done) break;
        handleAgentEvent(event);
      }
    } catch (err) {
      console.warn('[main] Event stream reader error:', err);
    }
  })();

  // T12: HTML5 drag-and-drop chat assets to dashboard grid
  document.addEventListener('dragstart', (e) => {
    const asset = e.target.closest('.draggable-chat-asset');
    if (!asset) return;
    const assetData = {
      type: asset.dataset.assetType,
      title: asset.dataset.title || 'Pinned Asset',
      sql: asset.dataset.sql || null,
      toolCallId: asset.dataset.toolCallId || null,
      colSpan: asset.dataset.assetType === 'table' ? 1 : 2,
      rowSpan: 1,
    };
    e.dataTransfer.setData('application/json', JSON.stringify(assetData));
    e.dataTransfer.effectAllowed = 'copyMove';
    document.getElementById('dashboard-grid')?.classList.add('is-dragging');
  });

  document.addEventListener('dragend', () => {
    document.getElementById('dashboard-grid')?.classList.remove('is-dragging');
    document.querySelectorAll('.grid-cell.drag-target-hover, .grid-cell.drag-target-invalid').forEach(el => {
      el.classList.remove('drag-target-hover', 'drag-target-invalid');
    });
  });

  // T8: "Save as View" click handler on chat and scratchpad query results
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-save-view-chat');
    if (!btn) return;
    const sql = btn.dataset.sql;
    if (sql) {
      explorerUi.openCreateViewModal(sql);
    }
  });
}

// ── Processing State ────────────────────────────────────────────────

function setLoading(on) {
  if (loadingEl) loadingEl.classList.toggle('hidden', true); // replaced by live streaming UI
  inputEl.disabled = on;
  sendBtn.disabled = on;
  // Lock session switching mid-turn: the capture triggers read
  // session_context.active_session_id at fire time, so switching sessions while
  // a turn is in flight would mis-stamp that turn's changesets. (The Stop button
  // is re-enabled separately by setSendButtonStop.)
  const sessionListEl = document.getElementById('session-list');
  if (sessionListEl) {
    sessionListEl.classList.toggle('disabled', on);
    sessionListEl.querySelectorAll('button').forEach(btn => btn.disabled = on);
  }
  const newSessionBtn = document.getElementById('btn-new-session');
  if (newSessionBtn) newSessionBtn.disabled = on;
  // T11: gate the dashboard grid while a turn is in flight — card CRUD issued
  // mid-turn would join the turn savepoint and roll back with it on a hard
  // error; data_change re-runs are deferred to the turn-end flush.
  gridUi.setBusy(on);
  isProcessing = on;
}

// T3: morph the Send button into a Stop button while a turn is in flight.
function setSendButtonStop(on) {
  if (!sendBtn) return;
  if (on) {
    sendBtn.dataset.mode = 'stop';
    sendBtn.textContent = '⏹ Stop';
    sendBtn.classList.add('stop-btn');
    // T3: the button is disabled by setLoading(true) at turn start, but Stop must
    // stay clickable while the turn is in flight — re-enable it here.
    sendBtn.disabled = false;
  } else {
    delete sendBtn.dataset.mode;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stop-btn');
  }
}

function updateReadyStatus() {
  const cfg = loadConfig();
  const provider = cfg.provider || 'openai';
  const url = cfg.url || (provider === 'openai' ? 'http://localhost:11434/v1' : '');
  const model = cfg.model || (provider === 'gemini' ? 'gemini-2.5-flash' : 'llama3.2');
  const apiKey = cfg.apiKey || '';

  if (provider === 'gemini') {
    if (apiKey) {
      statusBar.textContent = `● Ready — Google Gemini (${model})`;
      statusBar.style.color = '#3fb950';
    } else {
      statusBar.textContent = `○ Ready — Google Gemini (${model}) [API key needed]`;
      statusBar.style.color = '#d29922';
    }
  } else {
    statusBar.textContent = `● Ready — OpenAI Compatible at ${url} (${model})`;
    statusBar.style.color = '#3fb950';
  }
}

// ── Boot ────────────────────────────────────────────────────────────

async function bootAgent() {
  const cfg = loadConfig();
  const provider = cfg.provider || 'openai';
  const url = cfg.url || (provider === 'openai' ? 'http://localhost:11434/v1' : '');
  const model = cfg.model || (provider === 'gemini' ? 'gemini-2.5-flash' : 'llama3.2');
  const apiKey = cfg.apiKey || '';

  try {
    statusBar.textContent = 'Initializing wa-sqlite JSPI…';
    statusBar.style.color = '#8b949e';

    agent = await bootSqliteAgent({
      dbName: 'agent_brain.sqlite3',
      llmUrl: url,
      llmModel: model,
      llmApiKey: apiKey,
      llmProvider: provider,
    });

    // Debug/test handle (used by the cartridge round-trip tests & console).
    window.__agent = agent;

    // Start event stream listener
    startEventStreamListener();

    // Set active session
    activeSessionId = 'default';
    await setActiveSession(agent.sqlite3, agent.db, activeSessionId);

    // T3: clear any suppression flags left stuck at '1' by a crashed/reloaded
    // tab — a stuck suppress_cascade permanently kills the cascade on reboot.
    try {
      await setSuppressCascade(agent.sqlite3, agent.db, false);
      await setSuppressCapture(agent.sqlite3, agent.db, false);
    } catch (e) {
      console.warn('[main] T3 flag reset failed (non-fatal):', e);
    }

    // T3 & T21: attach capture triggers to every user data table (idempotent),
    // assert the protected-tables boundary invariant, and repair orphaned tool_call
    // pairs in EVERY session.
    try {
      await sweepCaptureTriggers(agent.sqlite3, agent.db);
      await assertProtectedTablesInvariant(agent.sqlite3, agent.db);
      const allSessions = await listSessions(agent.sqlite3, agent.db);
      for (const s of allSessions) {
        await repairOrphanedToolCalls(agent.sqlite3, agent.db, s.id);
      }
    } catch (e) {
      console.warn('[main] T3/T21 boot setup failed (non-fatal):', e);
    }

    // T2: persist the user's context-window override (settings field). Empty /
    // invalid → reset to the fallback sentinel (128000), so window resolution
    // falls through to the cloud model-name lookup. Then reflect the stored
    // value back into the field (the DB is the source of truth after boot).
    try {
      const raw = (cfg.contextWindow || '').trim();
      const n = parseInt(raw, 10);
      const value = (Number.isFinite(n) && n >= 1000) ? String(n) : String(FALLBACK_WINDOW);
      await execParams(agent.sqlite3, agent.db, `
        INSERT INTO system_config (key, value) VALUES ('effective_context_window', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `, [value]);
      const stored = await queryAll(agent.sqlite3, agent.db,
        `SELECT value FROM system_config WHERE key = 'effective_context_window'`);
      if (stored.length) configContextWindow.value = stored[0][0];
    } catch (e) {
      console.warn('[main] T2 context-window persist failed (non-fatal):', e);
    }

    updateReadyStatus();

    inputEl.disabled = false;
    sendBtn.disabled = false;

    await populateSessionDropdown();
    await renderMessages();

    // T11: 3-pane workstation — render the 3×3 dashboard grid (right pane),
    // the DB Explorer table list (left pane), and attach the data_change
    // reactivity stream. Expose the grid engine on the live handle for probes.
    try {
      window.__agent.grid = gridEngine;
      window.__agent.gridUi = gridUi;
      gridUi.initGridUi(agent);
    } catch (e) {
      console.warn('[main] T11 grid init failed (non-fatal):', e);
    }

    // T8: DB Schema Inspector & Explorer
    try {
      window.__agent.explorer = explorerEngine;
      window.__agent.explorerUi = explorerUi;
      window.__agent.renderMessages = renderMessages;
      explorerUi.initExplorerUi(agent);
    } catch (e) {
      console.warn('[main] T8 explorer init failed (non-fatal):', e);
    }

    // T24: SQL Autocomplete & Bang-Mode Visual Morphing
    try {
      await globalSchemaIndex.refreshFromDb(agent.sqlite3, agent.db);
      if (inputEl && !mainAutocomplete) {
        mainAutocomplete = new SqlAutocompleteController(inputEl, {
          schemaIndex: globalSchemaIndex,
          onBangModeChange: (bang) => updateBangModeVisuals(bang),
        });
      }
      window.__agent.schemaIndex = globalSchemaIndex;
      window.__agent.autocomplete = mainAutocomplete;
      window.__agent.updateBangModeVisuals = updateBangModeVisuals;
      window.__agent.runT24Probe = async () => {
        const { runT24Probe } = await import('../docs/prototypes/ticket-24-autocomplete-probe.mjs');
        return runT24Probe(agent);
      };
      window.__agent.runT21Probe = async () => {
        const { runT21Probe } = await import('../docs/prototypes/ticket-21-protected-tables-probe.mjs');
        return runT21Probe(agent);
      };
    } catch (e) {
      console.warn('[main] T24 autocomplete init failed (non-fatal):', e);
    }

    inputEl.focus();
  } catch (e) {
    console.error('[main] Boot failed:', e);
    statusBar.textContent = `⚠ Boot failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
}

// ── T24: Bang-Mode Visuals ──────────────────────────────────────────

let mainAutocomplete = null;

export function updateBangModeVisuals(bang) {
  const badgeEl = document.getElementById('bang-badge');
  if (!badgeEl || !inputEl) return;

  if (bang && bang.isBang) {
    badgeEl.classList.remove('hidden');
    badgeEl.classList.toggle('bang-private', bang.isPrivate);
    const icon = badgeEl.querySelector('.bang-badge-icon');
    const text = badgeEl.querySelector('.bang-badge-text');
    if (icon) icon.textContent = bang.isPrivate ? '🔒' : '⚡';
    if (text) text.textContent = bang.isPrivate ? '! Private SQL' : '! Direct SQL';

    inputEl.classList.add('bang-mode');
    inputEl.classList.add('has-bang-badge');
    inputEl.classList.toggle('bang-private', bang.isPrivate);
    inputEl.placeholder = bang.isPrivate
      ? 'Enter private SQL (hidden from agent context)…'
      : 'Enter SQL to execute directly (visible to agent)…';
  } else {
    badgeEl.classList.add('hidden');
    badgeEl.classList.remove('bang-private');
    inputEl.classList.remove('bang-mode', 'has-bang-badge', 'bang-private');
    inputEl.placeholder = 'Ask me to query your data… or run SQL: ! = agent sees it, !! = private';
  }
}

// ── Send Message ────────────────────────────────────────────────────

async function sendMessage(text) {
  if (isProcessing || !agent || !text.trim()) return;
  const userText = text.trim();

  // T2: manual compaction — /compact [instructions] (input interception, same
  // path as T9's bang commands; a command, not a message — never stored).
  const compactCmd = parseCompactCommand(userText);
  if (compactCmd) {
    inputEl.value = '';
    updateBangModeVisuals({ isBang: false });
    await runManualCompaction(compactCmd.instructions);
    return;
  }

  // T9: scratchpad branch — leading bang(s) mean "run this SQL directly",
  // bypassing the LLM trigger cascade entirely.
  const scratch = parseScratchpad(userText);
  if (scratch) {
    inputEl.value = '';
    updateBangModeVisuals({ isBang: false });
    await runScratchpad(scratch, userText);
    return;
  }

  inputEl.value = '';
  updateBangModeVisuals({ isBang: false });
  setLoading(true);
  setSendButtonStop(true); // T3: morph Send → Stop while the turn is in flight

  // Optimistically render user message immediately
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.textContent = userText;
  messagesEl.appendChild(userDiv);
  scrollChatToBottom();

  activeStreamingBubble = null;
  activeToolIndicator = null;

  const { sqlite3, db } = agent;
  const turnAbort = beginTurn(); // T3: reset stop state + create the turn AbortController

  try {
    // T2: proactive compaction — BEFORE the user-row insert / turn savepoint.
    // Provider-anchored estimate (latest assistant prompt_tokens + chars÷4 over
    // visible rows after it); over 85% of the resolved window → compact first.
    // The compaction commits independently of the turn's savepoint (T3).
    try {
      await maybeProactiveCompaction(sqlite3, db, turnAbort.signal);
    } catch (e) {
      // Stop during the compaction fetch → end the turn cleanly (the user
      // message was never inserted). Any other failure is non-fatal: the turn
      // proceeds and the reactive trigger catches a context-length 400.
      if (isStopRequested() || (e && e.name === 'AbortError')) {
        agent.eventStream?.emit('done', { stopped: true });
        return;
      }
      console.warn('[main] Proactive compaction failed (non-fatal):', e);
    }

    // T3: open the turn savepoint. SAVEPOINT is illegal inside a trigger body,
    // so it must be opened from JS; the whole cascade runs inside it.
    await sqlite3.exec(db, 'SAVEPOINT turn_sp');

    // Single INSERT → trigger cascade (JSPI suspends during LLM fetches &
    // streaming) → done.
    const sql = `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`;
    for await (const stmt of sqlite3.statements(db, sql)) {
      sqlite3.bind_collection(stmt, [activeSessionId, userText]);
      await sqlite3.step(stmt);
    }

    // Normal end (or graceful stop) → commit the turn.
    await sqlite3.exec(db, 'RELEASE turn_sp');

    // T3: evict changesets beyond the 20-turn rolling window.
    await evictChangesets(sqlite3, db, activeSessionId, 20);

    // Update session's updated_at timestamp.
    for await (const stmt of sqlite3.statements(db, `UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`)) {
      sqlite3.bind_collection(stmt, [activeSessionId]);
      await sqlite3.step(stmt);
    }

    // Emit 'done' event
    agent.eventStream?.emit('done', { sessionId: activeSessionId });
  } catch (e) {
    // T3: hard error — ask_llm re-threw a transport error (or a tool UDF threw).
    // Roll back the whole turn, then re-insert the user message (cascade
    // suppressed) + an assistant error note.
    console.error('[main] Cascade error, rolling back turn:', e);
    try {
      await sqlite3.exec(db, 'ROLLBACK TO turn_sp; RELEASE turn_sp;');
    } catch (rbErr) {
      console.error('[main] Rollback failed:', rbErr);
      try { await sqlite3.exec(db, 'RELEASE turn_sp'); } catch { /* already gone */ }
    }

    // Re-insert the user message with the cascade suppressed. The flag toggle
    // MUST be in try/finally — a stuck '1' permanently kills the cascade.
    await setSuppressCascade(sqlite3, db, true);
    try {
      const ins = `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`;
      for await (const stmt of sqlite3.statements(db, ins)) {
        sqlite3.bind_collection(stmt, [activeSessionId, userText]);
        await sqlite3.step(stmt);
      }
      const errNote = `⚠ **Turn failed** — the model request could not complete (${e.message}). Your message was kept; please try again.`;
      const insErr = `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`;
      for await (const stmt of sqlite3.statements(db, insErr)) {
        sqlite3.bind_collection(stmt, [activeSessionId, errNote]);
        await sqlite3.step(stmt);
      }
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    agent.eventStream?.emit('error', { error: e.message });
    statusBar.textContent = `⚠ Error: ${e.message}`;
    statusBar.style.color = '#f85149';
  } finally {
    endTurn();
    setSendButtonStop(false);
    setLoading(false);
    // Reconcile and finalize state with SQLite database
    await renderMessages();
    // T11: re-run dashboard cards whose data tables changed during the turn
    // (committed point — after RELEASE / ROLLBACK, so rollback is visible).
    try { await gridUi.flushCards(); } catch (e) { console.warn('[main] card flush failed (non-fatal):', e); }
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    updateReadyStatus();
  }
}

// ── T2: Context Compaction ──────────────────────────────────────────
//
// The LLM's working context is the v_active_context view (system + latest
// rolling summary + rows after the compaction watermark). Three triggers:
//   - proactive: at turn start, if the provider-anchored estimate is over 85%
//                of the resolved window (see maybeProactiveCompaction).
//   - reactive:  inside ask_llm on a context-length 400 (harness.js).
//   - manual:    /compact [instructions] — summarize the ENTIRE active context
//                (keep 0, tau's manual behavior).
// Compaction writes a row to `compactions` (summaries only); `messages` is
// never touched. The chat divider (renderMessages) marks each watermark.

/** Parse a /compact [instructions] command. Returns null for normal chat. */
function parseCompactCommand(text) {
  const m = text.trim().match(/^\/compact(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { instructions: (m[1] || '').trim() || undefined };
}

/** Manual compaction: /compact [instructions] — keep 0, summarize everything. */
async function runManualCompaction(instructions) {
  if (!agent) return;
  const { sqlite3, db } = agent;
  setLoading(true);
  setSendButtonStop(true); // Stop works: the summary fetch uses the turn signal
  const turnAbort = beginTurn();
  try {
    statusBar.textContent = 'Compacting context…';
    statusBar.style.color = '#d29922';
    const result = await runCompaction(sqlite3, db, activeSessionId, agent.llm, {
      instructions,
      keepBudget: 0, // manual: summarize the ENTIRE active context
      reason: 'manual',
      signal: turnAbort.signal,
    });
    if (result) {
      statusBar.textContent = `✓ Context compacted (summarized ${result.summarizedCount} messages)`;
      statusBar.style.color = '#3fb950';
    } else {
      statusBar.textContent = 'Nothing to compact.';
      statusBar.style.color = '#8b949e';
    }
  } catch (e) {
    if (isStopRequested() || (e && e.name === 'AbortError')) {
      statusBar.textContent = '⏹ Compaction stopped.';
      statusBar.style.color = '#d29922';
    } else {
      console.error('[compact]', e);
      statusBar.textContent = `⚠ Compaction failed: ${e.message}`;
      statusBar.style.color = '#f85149';
    }
  } finally {
    endTurn();
    setSendButtonStop(false);
    setLoading(false);
    await renderMessages();
    inputEl.focus();
    setTimeout(updateReadyStatus, 3000);
  }
}

/**
 * Proactive compaction at turn start (before the user-row insert / savepoint).
 * Provider-anchored estimate: the latest assistant row's prompt_tokens +
 * chars÷4 over the visible rows after it. Over 85% of the resolved window →
 * compact first. Returns true if a compaction was performed.
 */
async function maybeProactiveCompaction(sqlite3, db, signal) {
  if (!agent?.llm?.endpointUrl) return false; // no LLM endpoint — nothing to compact
  const rows = await queryAll(sqlite3, db, `SELECT value FROM system_config WHERE key = 'effective_context_window'`);
  const window = resolveContextWindow(rows.length ? rows[0][0] : null, agent.llm.model);
  const est = await estimateActiveContextTokens(sqlite3, db, activeSessionId);
  if (est <= window * COMPACTION_THRESHOLD) return false;

  // Session switcher guard (setLoading(true) already disabled it — belt and
  // braces, per the design: "disabled during the compaction fetch").
  const sList = document.getElementById('session-list');
  if (sList) sList.querySelectorAll('button').forEach(btn => btn.disabled = true);
  statusBar.textContent = `Compacting context… (~${Math.round(est / 1000)}k / ${Math.round(window * COMPACTION_THRESHOLD / 1000)}k token threshold)`;
  statusBar.style.color = '#d29922';
  const result = await runCompaction(sqlite3, db, activeSessionId, agent.llm, { reason: 'proactive', signal });
  if (result) {
    console.log(`[main] Proactive compaction: seq=${result.seq} watermark=${result.watermarkId} summarized=${result.summarizedCount}`);
  }
  return !!result;
}

// ── T3: Rewind ──────────────────────────────────────────────────────

async function rewindToBefore(messageId) {
  if (!agent || isProcessing) return;
  const { sqlite3, db } = agent;
  try {
    const summary = await getChangesetSummary(sqlite3, db, activeSessionId, messageId);
    const ok = confirm(
      `Rewind the database to the state before this message?\n\n` +
      `This undoes:\n${summary}\n\n` +
      `The conversation history is preserved (data-only rewind).`
    );
    if (!ok) return;

    statusBar.textContent = '⟲ Rewinding…';
    statusBar.style.color = '#d29922';
    const n = await rewindToBeforeTurn(sqlite3, db, activeSessionId, messageId);
    statusBar.textContent = `✓ Rewound ${n} turn${n === 1 ? '' : 's'}`;
    statusBar.style.color = '#3fb950';
    await renderMessages();
    setTimeout(updateReadyStatus, 3000);
  } catch (e) {
    console.error('[rewind]', e);
    statusBar.textContent = `⚠ Rewind failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
}

// ── T9: Direct SQL Scratchpad (! / !!) ──────────────────────────────
//
// Input grammar (checked in sendMessage before the normal LLM path):
//   !SQL   → run ANY SQL directly (bypasses the LLM trigger); the command +
//            result are stored with in_context = 1 — the agent SEES them in
//            its context and can build on them.
//   !!SQL  → run ANY SQL directly; stored with in_context = 0 — PRIVATE,
//            the agent never sees the command or its result.
//
// No write gates: the bang prefix is the explicitness marker (it's a command
// the human typed). Every WRITE statement (DML + DDL) asks for confirmation
// before executing; reads (SELECT/WITH/EXPLAIN/…) run immediately.
// system_config.allow_dml is untouched — it gates the AGENT's execute_sql
// tool only (T3).
//
// Turn identity: the scratchpad user row's message id M becomes turn_id = -M
// (negative, per T3) so its changesets/DDL log never pollute the real turn
// sequence and are rewound-able via the bubble's ⟲ (see
// rewindToBeforeScratchpadTurn).

class ScratchpadCancelled extends Error {
  constructor(statement) {
    super('cancelled');
    this.statement = statement;
  }
}

/** Parse a leading-bang scratchpad command. Returns null for normal chat. */
function parseScratchpad(text) {
  const m = text.trim().match(/^(!+)([\s\S]*)$/);
  if (!m) return null;
  const sql = m[2].trim();
  if (!sql) return null; // bare "!" → treat as a normal (weird) chat message
  return { bangs: m[1].length, sql, inContext: m[1].length === 1 };
}

/**
 * Classify one statement.
 *   read      → SELECT / WITH / EXPLAIN (runs immediately, no confirm)
 *   dml       → INSERT / UPDATE / DELETE (confirm, captured by row triggers)
 *   ddl       → CREATE / DROP / ALTER (confirm, logged to turn_ddl_log)
 *   forbidden → transaction control (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/…) —
 *               would break the scratchpad savepoint protocol; rejected
 *               before execution.
 *   other     → anything else (PRAGMA, VACUUM, …) — executed as-is; SQLite's
 *               own errors surface in the result bubble (e.g. VACUUM cannot
 *               run inside the scratchpad savepoint).
 */
function classifyStatement(sql) {
  const t = sql.trim().replace(/;+\s*$/, '').trim();
  const first = (t.split(/\s+/)[0] || '').toUpperCase();
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END'].includes(first)) {
    return { kind: 'forbidden', reason: `Transaction-control statements (${first}) cannot run inside the scratchpad savepoint.` };
  }

  // T21: Protected-tables boundary check on scratchpad queries
  const targets = extractTargetTables(sql);
  for (const target of targets) {
    if (isProtectedTable(target.name)) {
      if (target.operation === 'ddl') {
        return {
          kind: 'forbidden',
          reason: `Operation rejected: Cannot execute DDL (${target.verb}) on protected table "${target.name}".`,
        };
      }
      if (target.operation === 'dml') {
        // Option A: Only allow system_config modifications
        if (target.name.toLowerCase() !== 'system_config') {
          return {
            kind: 'forbidden',
            reason: `Operation rejected: Direct modification of protected system table "${target.name}" is not permitted.`,
          };
        }
      }
    }
  }

  if (first === 'SELECT' || first === 'EXPLAIN') return { kind: 'read' };
  if (first === 'WITH') {
    // A data-modifying CTE (`WITH … INSERT/UPDATE/DELETE/REPLACE`) is a WRITE
    // — the keyword heuristic errs safe (a string literal containing "DELETE"
    // just costs an extra confirm).
    return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t) ? { kind: 'dml' } : { kind: 'read' };
  }
  if (first === 'INSERT' || first === 'UPDATE' || first === 'DELETE' || first === 'REPLACE') {
    return { kind: 'dml' };
  }
  if (first === 'CREATE' || first === 'DROP' || first === 'ALTER') {
    let ddlType = 'other', target = '';
    let m = t.match(/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|VIEW)\b/i);
    if (m) { ddlType = 'create'; target = m[1].toLowerCase(); }
    else if ((m = t.match(/^DROP\s+(TABLE|INDEX|VIEW)\b/i))) { ddlType = 'drop'; target = m[1].toLowerCase(); }
    else if (/^ALTER\s+TABLE\b/i.test(t)) { ddlType = 'alter'; target = 'table'; }
    // Reversible: CREATE TABLE (inverse = drop) and DROP TABLE (inverse =
    // pre-image restore). ALTER / other DDL are logged but not auto-reversible.
    const reversible = (ddlType === 'create' && target === 'table') ||
                       (ddlType === 'drop' && target === 'table');
    return { kind: 'ddl', ddlType, target, reversible };
  }
  return { kind: 'other' };
}

function unquoteIdent(name) {
  if ((name.startsWith('"') && name.endsWith('"')) ||
      (name.startsWith('`') && name.endsWith('`')) ||
      (name.startsWith('[') && name.endsWith(']'))) {
    return name.slice(1, -1);
  }
  return name;
}

/** Best-effort object name from a CREATE/DROP/ALTER statement (null if unparseable).
 *  Handles bare, double-quoted, backtick, and [bracket] identifiers. */
function extractDdlTableName(sql) {
  const t = sql.trim().replace(/;+\s*$/, '').trim();
  // Quoted identifiers may contain spaces; bare ones may not.
  // NOTE: the name group MUST be capturing — m[1] is the identifier.
  const name = '("[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
  // SQLite: CREATE [TEMP|TEMPORARY] [UNIQUE] TABLE … (UNIQUE precedes TABLE).
  let m = t.match(new RegExp(`^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?(?:UNIQUE\\s+)?(?:TABLE|INDEX|VIEW)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}`, 'i'));
  if (m) return unquoteIdent(m[1]);
  m = t.match(new RegExp(`^DROP\\s+(?:TABLE|INDEX|VIEW)\\s+(?:IF\\s+EXISTS\\s+)?${name}`, 'i'));
  if (m) return unquoteIdent(m[1]);
  m = t.match(new RegExp(`^ALTER\\s+TABLE\\s+${name}`, 'i'));
  if (m) return unquoteIdent(m[1]);
  return null;
}

/**
 * Capture a pre-image for DROP TABLE so ⟲ can restore it:
 * { create_sql, columns, rows } — rows are JSON objects keyed by column.
 * Must run BEFORE the drop (it SELECTs the table).
 */
async function captureDropPreImage(sqlite3, db, tableName) {
  const master = await queryAll(sqlite3, db,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [tableName]);
  if (!master.length) return null;
  const createSql = master[0][0];

  const cols = [];
  for await (const stmt of sqlite3.statements(db, `PRAGMA table_info(${quoteIdent(tableName)})`)) {
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      cols.push(sqlite3.row(stmt)[1]);
    }
  }
  if (!cols.length) return null;

  const rows = [];
  const colList = cols.map(quoteIdent).join(', ');
  for await (const stmt of sqlite3.statements(db, `SELECT ${colList} FROM ${quoteIdent(tableName)}`)) {
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      const v = sqlite3.row(stmt);
      const obj = {};
      cols.forEach((c, i) => { obj[c] = v[i]; });
      rows.push(obj);
    }
  }
  return { create_sql: createSql, columns: cols, rows };
}

/** Confirm a write command before it executes (reads skip this). */
function confirmScratchpadWrite(cls, sql, tableName) {
  let what;
  if (cls.kind === 'ddl') {
    const verb = cls.ddlType === 'drop' ? 'DROP' : cls.ddlType === 'alter' ? 'ALTER TABLE' : 'CREATE';
    what = `${verb} ${tableName || '(…)'}`.trim();
  } else {
    what = sql.split('\n')[0].slice(0, 120);
  }
  const rev = cls.kind === 'ddl'
    ? (cls.reversible ? ' (rewound-able via ⟲)' : ' — NOT auto-rewound-able')
    : (cls.kind === 'dml' ? ' (rewound-able via ⟲)' : '');
  return confirm(`Run this write command?\n\n${what}\n${rev}`);
}

/** Insert a message row and return its new id (last_insert_rowid()). */
async function insertMessage(sqlite3, db, sessionId, role, content, inContext) {
  for await (const stmt of sqlite3.statements(db,
    `INSERT INTO messages (session_id, role, content, in_context) VALUES (?, ?, ?, ?)`)) {
    sqlite3.bind_collection(stmt, [sessionId, role, content, inContext ? 1 : 0]);
    await sqlite3.step(stmt);
  }
  const rows = await queryAll(sqlite3, db, `SELECT last_insert_rowid()`);
  return rows[0][0];
}

/**
 * Execute a scratchpad SQL string (possibly multi-statement) inside the
 * caller's savepoint. Per statement: classify → confirm (writes) → DDL
 * pre-image + logDDL (before execution) → execute → re-sweep capture
 * triggers after DDL.
 */
async function execScratchSql(sqlite3, db, sql, turnId, sessionId) {
  const results = [];
  const infos = [];

  for await (const stmt of sqlite3.statements(db, sql)) {
    const text = (sqlite3.sql(stmt) || '').trim();
    if (!text) continue;
    const cls = classifyStatement(text);
    const tableName = cls.kind === 'ddl' ? extractDdlTableName(text) : null;

    // Transaction control or protected-table modifications are forbidden in scratchpad.
    if (cls.kind === 'forbidden') {
      throw new Error(cls.reason || `Forbidden statement (${text.split(/\s+/)[0]}) cannot run inside scratchpad.`);
    }

    // Every write command confirms before executing (reads run immediately).
    if (cls.kind !== 'read') {
      if (!confirmScratchpadWrite(cls, text, tableName)) throw new ScratchpadCancelled(text);
    }

    // DDL: log with pre-image BEFORE executing (the drop must see the rows).
    if (cls.kind === 'ddl') {
      let preImage = null;
      if (cls.ddlType === 'drop' && cls.target === 'table' && tableName) {
        preImage = await captureDropPreImage(sqlite3, db, tableName);
      }
      await logDDL(sqlite3, db, { turnId, sessionId, tableName, ddlSql: text, preImage });
    }

    if (cls.kind === 'read' || cls.kind === 'other') {
      // Row-returning statement (SELECT/WITH/EXPLAIN/PRAGMA/…).
      const cols = sqlite3.column_names(stmt);
      const values = [];
      while (await sqlite3.step(stmt) === SQLITE_ROW) {
        values.push(sqlite3.row(stmt));
        if (values.length >= SCRATCH_ROW_CAP) break;
      }
      if (cols.length) {
        results.push({ columns: cols, values, truncated: values.length >= SCRATCH_ROW_CAP });
      }
    } else {
      // DML / DDL — run to completion, report affected rows.
      while (await sqlite3.step(stmt) !== SQLITE_DONE) { /* step */ }
      const n = sqlite3.changes(db);
      if (cls.kind === 'ddl') {
        const verb = cls.ddlType === 'drop' ? 'dropped' : cls.ddlType === 'alter' ? 'altered' : 'created';
        infos.push(`✓ ${verb} ${tableName || 'object'}${cls.reversible ? '' : ' (NOT rewound-able)'}`);
      } else {
        infos.push(`✓ ${n} row${n === 1 ? '' : 's'} affected`);
      }
    }

    // DDL invalidates the capture-trigger landscape: DROP TABLE drops its
    // triggers, CREATE TABLE leaves the new table uninstrumented. Re-sweep.
    if (cls.kind === 'ddl') {
      await sweepCaptureTriggers(sqlite3, db);
    }
  }

  return { results, infos };
}

/**
 * Run a parsed scratchpad command end-to-end. Mirrors the T3 turn wrapper:
 * savepoint around user row + execution + result row; on error, roll back
 * and re-insert the user row + an error result row (cascade suppressed in
 * try/finally — a stuck flag permanently kills the cascade).
 */
async function runScratchpad(cmd, rawText) {
  const { sqlite3, db } = agent;
  const t0 = performance.now();
  setLoading(true);

  // Optimistically render the user bubble (monospace, badge).
  const userDiv = document.createElement('div');
  userDiv.className = 'message user scratchpad';
  userDiv.textContent = rawText;
  messagesEl.appendChild(userDiv);
  scrollChatToBottom();

  try {
    await setSuppressCascade(sqlite3, db, true);
    try {
      // The user row + result row + all data changes commit atomically.
      await execSqlRaw(sqlite3, db, 'SAVEPOINT scratch_sp');
      try {
        // 1. User row (cascade suppressed — agent_think must NOT fire).
        //    in_context: `!` = 1 (agent sees it), `!!` = 0 (private).
        const M = await insertMessage(sqlite3, db, activeSessionId, 'user', rawText, cmd.inContext);

        // 2. Negative turn identity: -M. The agent_turn_init trigger set
        //    current_turn_id = +M on the insert; overwrite BEFORE any DML so
        //    the capture triggers stamp this command's changes with -M.
        await setCurrentTurnId(sqlite3, db, -M);

        // 3. Execute (confirms may pause here; a cancel throws).
        const { results, infos } = await execScratchSql(sqlite3, db, cmd.sql, -M, activeSessionId);

        // 4. Result row (assistant, JSON envelope).
        const envelope = {
          scratchpad: true,
          sql: cmd.sql,
          bangs: cmd.bangs,
          results,
          infos,
          ms: Math.round(performance.now() - t0),
        };
        await insertMessage(sqlite3, db, activeSessionId, 'assistant', JSON.stringify(envelope), cmd.inContext);

        await execSqlRaw(sqlite3, db, 'RELEASE scratch_sp');
      } catch (e) {
        // SQL error or user cancelled a confirm — roll back partial work
        // (including the user row). The re-insert happens in the outer catch.
        try {
          await execSqlRaw(sqlite3, db, 'ROLLBACK TO scratch_sp; RELEASE scratch_sp;');
        } catch {
          try { await execSqlRaw(sqlite3, db, 'RELEASE scratch_sp'); } catch { /* already gone */ }
        }
        throw e;
      }
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    // Bookkeeping (work is committed — failures here are non-fatal).
    try { await evictChangesets(sqlite3, db, activeSessionId, 20); } catch (e) { console.warn('[scratchpad] evict failed (non-fatal):', e); }
    try {
      for await (const stmt of sqlite3.statements(db, `UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`)) {
        sqlite3.bind_collection(stmt, [activeSessionId]);
        await sqlite3.step(stmt);
      }
    } catch (e) { console.warn('[scratchpad] session touch failed (non-fatal):', e); }
  } catch (e) {
    // Re-insert the user row + an error result row (cascade suppressed).
    if (!(e instanceof ScratchpadCancelled)) console.error('[scratchpad] execution failed:', e);
    const errMsg = e instanceof ScratchpadCancelled
      ? `Cancelled — “${String(e.statement).split('\n')[0].slice(0, 80)}” was not executed.`
      : (e && e.message) || String(e);
    try {
      await setSuppressCascade(sqlite3, db, true);
      try {
        await insertMessage(sqlite3, db, activeSessionId, 'user', rawText, cmd.inContext);
        const envelope = {
          scratchpad: true, sql: cmd.sql, bangs: cmd.bangs,
          error: errMsg, ms: Math.round(performance.now() - t0),
        };
        await insertMessage(sqlite3, db, activeSessionId, 'assistant', JSON.stringify(envelope), cmd.inContext);
      } finally {
        await setSuppressCascade(sqlite3, db, false);
      }
    } catch (e2) {
      console.error('[scratchpad] error-row re-insert failed:', e2);
    }
    statusBar.textContent = `⚠ ${errMsg}`;
    statusBar.style.color = '#f85149';
  } finally {
    setLoading(false);
    await renderMessages();
    // T11: re-run dashboard cards whose data tables changed (committed point).
    try { await gridUi.flushCards(); } catch (e) { console.warn('[main] card flush failed (non-fatal):', e); }
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    updateReadyStatus();
  }
}

/** Tiny exec helper (no binds) for the scratchpad savepoint statements. */
async function execSqlRaw(sqlite3, db, sql) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    await sqlite3.step(stmt);
  }
}

// ── T9: Scratchpad Rewind (per-bubble ⟲ on !! / writing ! commands) ───

async function rewindToBeforeScratchpad(messageId) {
  if (!agent || isProcessing) return;
  const { sqlite3, db } = agent;
  try {
    const turnId = -messageId; // scratchpad turns are negative
    const summary = await getScratchpadChangesetSummary(sqlite3, db, activeSessionId, turnId);
    const ok = confirm(
      `Rewind the database to the state before this scratchpad command?\n\n` +
      `This undoes:\n${summary}\n\n` +
      `The conversation history is preserved (data-only rewind).`
    );
    if (!ok) return;

    statusBar.textContent = '⟲ Rewinding scratchpad…';
    statusBar.style.color = '#d29922';
    const n = await rewindToBeforeScratchpadTurn(sqlite3, db, activeSessionId, turnId);
    statusBar.textContent = `✓ Rewound ${n} scratchpad command${n === 1 ? '' : 's'}`;
    statusBar.style.color = '#3fb950';
    await renderMessages();
    setTimeout(updateReadyStatus, 3000);
  } catch (e) {
    console.error('[scratchpad-rewind]', e);
    statusBar.textContent = `⚠ Rewind failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
}

// ── Event Listeners ─────────────────────────────────────────────────

formEl.addEventListener('submit', e => { e.preventDefault(); sendMessage(inputEl.value); });

// T3: when the Send button has morphed into Stop, a click aborts the in-flight
// turn instead of submitting a new message.
sendBtn.addEventListener('click', (e) => {
  if (sendBtn.dataset.mode === 'stop') {
    e.preventDefault();
    requestStop();
  }
});

configProvider.addEventListener('change', () => {
  updateConfigVisibility(configProvider.value);
});

configForm.addEventListener('submit', e => {
  e.preventDefault();
  const provider = configProvider.value;
  const config = {
    provider,
    url: provider === 'openai' ? (configUrl.value.trim() || 'http://localhost:11434/v1') : '',
    model: configModel.value.trim() || (provider === 'gemini' ? 'gemini-2.5-flash' : 'llama3.2'),
    apiKey: configKey.value.trim(),
    contextWindow: configContextWindow.value.trim(), // T2: '' = auto (cloud lookup / fallback)
  };
  saveConfig(config);
  document.getElementById('config-details').open = false;
  bootAgent();
});

populateConfigForm();
bootAgent();

// ── Cartridge Import/Export ─────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', async () => {
  if (!agent) return;
  try {
    statusBar.textContent = 'Exporting cartridge…';
    statusBar.style.color = '#d29922';
    const result = await exportCartridge(agent.sqlite3, agent.module, agent.db, `bobby-brain-${new Date().toISOString().slice(0, 10)}.sqlite3`);
    if (result?.cancelled) {
      updateReadyStatus();
      return;
    }
    statusBar.textContent = `✓ Exported ${result.bytes} bytes`;
    statusBar.style.color = '#3fb950';
    setTimeout(() => {
      updateReadyStatus();
    }, 3000);
  } catch (e) {
    if (e.name === 'AbortError') {
      updateReadyStatus();
      return;
    }
    console.error('[export]', e);
    // Fallback to SQL dump only on actual engine error, never on user cancel
    try {
      statusBar.textContent = 'Binary export unavailable, trying SQL dump…';
      const sqlResult = await exportSqlDump(agent.sqlite3, agent.db, `bobby-brain-${new Date().toISOString().slice(0, 10)}.sql`);
      if (sqlResult?.cancelled) {
        updateReadyStatus();
        return;
      }
      statusBar.textContent = '✓ SQL dump exported';
      statusBar.style.color = '#3fb950';
      setTimeout(() => {
        updateReadyStatus();
      }, 3000);
    } catch (e2) {
      if (e2.name === 'AbortError') {
        updateReadyStatus();
        return;
      }
      console.error('[export sql]', e2);
      statusBar.textContent = `⚠ Export failed: ${e2.message}`;
      statusBar.style.color = '#f85149';
    }
  }
});

document.getElementById('btn-import').addEventListener('click', async () => {
  if (!agent) return;
  try {
    statusBar.textContent = 'Importing cartridge…';
    statusBar.style.color = '#d29922';
    // Same DB handle is preserved by importCartridge — UDFs, the update hook,
    // and connection-level pragmas all survive, so nothing to re-register.
    const result = await importCartridge(agent.sqlite3, agent.module, agent.db);
    if (result?.cancelled) {
      updateReadyStatus();
      return;
    }

    activeSessionId = 'default';
    await setActiveSession(agent.sqlite3, agent.db, 'default');
    await populateSessionDropdown();
    await renderMessages();
    // T11: the whole DB was replaced — rebuild the dashboard grid + explorer
    // from the imported brain (cards referencing dropped tables show errors).
    try { await gridUi.rebuildGrid(); } catch (e) { console.warn('[main] grid rebuild failed (non-fatal):', e); }
    statusBar.textContent = '✓ Cartridge imported';
    statusBar.style.color = '#3fb950';
    setTimeout(() => {
      updateReadyStatus();
    }, 3000);
  } catch (e) {
    if (e.name === 'AbortError') {
      updateReadyStatus();
      return;
    }
    console.error('[import]', e);
    statusBar.textContent = `⚠ Import failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
});

// ── CSV Ingestion & Drag-and-Drop ───────────────────────────────────

let dragCounter = 0;

function showDragOverlay() {
  if (dragOverlay) dragOverlay.classList.remove('hidden');
}

function hideDragOverlay() {
  if (dragOverlay) dragOverlay.classList.add('hidden');
}

function showIngestionProgress(fileName) {
  if (!ingestionProgress) return;
  ingestionProgress.classList.remove('hidden');
  if (progressTitle) progressTitle.textContent = `Ingesting ${fileName}…`;
  if (progressCount) progressCount.textContent = 'Parsing schema…';
  if (progressBarFill) {
    progressBarFill.className = 'progress-bar-fill indeterminate';
    progressBarFill.style.width = '100%';
  }
}

function hideIngestionProgress() {
  if (!ingestionProgress) return;
  ingestionProgress.classList.add('hidden');
  if (progressBarFill) {
    progressBarFill.className = 'progress-bar-fill';
    progressBarFill.style.width = '0%';
  }
}

async function handleCsvUpload(file) {
  if (!file) return;
  if (isProcessing) {
    alert('Please wait for the current turn to finish before uploading a CSV.');
    return;
  }
  if (!agent) {
    alert('Agent is still initializing. Please wait a moment.');
    return;
  }

  const isCsv = file.name.toLowerCase().endsWith('.csv') ||
                file.name.toLowerCase().endsWith('.tsv') ||
                file.name.toLowerCase().endsWith('.txt') ||
                file.type === 'text/csv' ||
                file.type === 'text/plain';

  if (!isCsv) {
    alert('Please select a valid CSV or tabular data file.');
    return;
  }

  showIngestionProgress(file.name);
  setLoading(true);
  statusBar.textContent = `Ingesting ${file.name}…`;
  statusBar.style.color = '#d29922';

  try {
    const result = await ingestCsvToSqlite(
      agent.sqlite3,
      agent.db,
      file,
      null,
      (progress) => {
        if (progress.phase === 'schema_inferred') {
          if (progressTitle) progressTitle.textContent = `Ingesting "${progress.tableName}"…`;
          if (progressCount) progressCount.textContent = `Inferred ${progress.columns?.length || 0} cols`;
        } else if (progress.phase === 'inserting') {
          if (progressTitle) progressTitle.textContent = `Ingesting "${progress.tableName}"…`;
          if (progressCount) progressCount.textContent = `${progress.rowsIngested.toLocaleString()} rows`;
        } else if (progress.phase === 'complete') {
          if (progressTitle) progressTitle.textContent = `✓ Ingested "${progress.tableName}"`;
          if (progressCount) progressCount.textContent = `${progress.rowsIngested.toLocaleString()} rows`;
          if (progressBarFill) {
            progressBarFill.className = 'progress-bar-fill';
            progressBarFill.style.width = '100%';
          }
        }
      }
    );

    // T3: attach row-image capture triggers to the new table so its changes
    // are rewound-able.
    try {
      await ensureCaptureTriggers(agent.sqlite3, agent.db, result.tableName);
    } catch (e) {
      console.warn('[csv-ingestion] Failed to attach capture triggers:', e);
    }

    setTimeout(() => {
      hideIngestionProgress();
    }, 1500);

    statusBar.textContent = `✓ Ingested table "${result.tableName}" (${result.rowCount.toLocaleString()} rows, ${result.columnCount} cols)`;
    statusBar.style.color = '#3fb950';

    // Insert confirmation assistant message into SQLite messages table for the active session
    const colList = result.columns.map(c => `• \`${c.name}\` (${c.type})`).join('\n');
    const notification = `📊 **Table Ingested: \`${result.tableName}\`**\n\n` +
      `- **Rows:** ${result.rowCount.toLocaleString()}\n` +
      `- **Columns (${result.columnCount}):**\n${colList}\n\n` +
      `The table is now queryable via SQL. Try asking:\n` +
      `• *"Show me the first 5 rows of ${result.tableName}"*\n` +
      `• *"What are the summary statistics for ${result.tableName}?"*`;

    for await (const stmt of agent.sqlite3.statements(
      agent.db,
      `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`
    )) {
      agent.sqlite3.bind_collection(stmt, [activeSessionId, notification]);
      await agent.sqlite3.step(stmt);
    }

    await renderMessages();
  } catch (err) {
    console.error('[csv-ingestion] Ingestion failed:', err);
    hideIngestionProgress();
    statusBar.textContent = `⚠ Ingestion failed: ${err.message}`;
    statusBar.style.color = '#f85149';

    const errorNotification = `⚠ **Failed to ingest CSV "${file.name}"**\n\nError: ${err.message}`;
    for await (const stmt of agent.sqlite3.statements(
      agent.db,
      `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`
    )) {
      agent.sqlite3.bind_collection(stmt, [activeSessionId, errorNotification]);
      await agent.sqlite3.step(stmt);
    }
    await renderMessages();
  } finally {
    setLoading(false);
    // T11: re-run dashboard cards whose data tables changed (new/updated table).
    try { await gridUi.flushCards(); } catch (e) { console.warn('[main] card flush failed (non-fatal):', e); }
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// Drag and drop event listeners
if (chatContainer) {
  chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
      showDragOverlay();
    }
  });

  chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      hideDragOverlay();
    }
  });

  chatContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    hideDragOverlay();

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await handleCsvUpload(files[0]);
    }
  });
}

// Window level drag prevention so browser doesn't open dropped file in tab
window.addEventListener('dragover', (e) => {
  e.preventDefault();
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
});

// T11 follow-up: draggable dividers between the 3 panes (pure UI state;
// widths persist in localStorage, never in the brain DB).
initPaneResizers();

// CSV Upload button handler
if (btnUploadCsv && csvFileInput) {
  btnUploadCsv.addEventListener('click', () => {
    csvFileInput.click();
  });

  csvFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      await handleCsvUpload(file);
      csvFileInput.value = '';
    }
  });
}


