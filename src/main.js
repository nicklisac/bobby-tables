/**
 * MAIN — Entry point. One INSERT triggers the pure-SQL ReAct cascade.
 *
 * Session-aware: messages are partitioned by session_id.
 * UI supports session switching, creation, and deletion.
 * Live Event Streaming: renders tokens, tool execution indicators, and results in real time.
 */

import { bootSqliteAgent, getEventStream, beginTurn, requestStop, endTurn, isStopRequested } from './harness.js';
import {
  setActiveSession, createSession, listSessions, deleteSession, getSessionTokenUsage,
  sweepCaptureTriggers, repairOrphanedToolCalls, evictChangesets, setSuppressCascade,
  setSuppressCapture, ensureCaptureTriggers, setCurrentTurnId,
  getRewindableScratchpadTurns, queryAll, quoteIdent, logDDL, execParams,
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
import { SQLITE_ROW, SQLITE_DONE } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
import './styles.css';

const messagesEl        = document.getElementById('messages');
const loadingEl         = document.getElementById('loading');
const formEl            = document.getElementById('input-form');
const inputEl           = document.getElementById('user-input');
const sendBtn           = document.getElementById('send-btn');
const statusBar         = document.getElementById('status-bar');
const configForm        = document.getElementById('config-form');
const configProvider    = document.getElementById('config-provider');
const rowConfigUrl      = document.getElementById('row-config-url');
const configUrl         = document.getElementById('config-url');
const configModel       = document.getElementById('config-model');
const configKey         = document.getElementById('config-key');
const labelConfigKey    = document.getElementById('label-config-key');
const configContextWindow = document.getElementById('config-context-window');
const sessionSelect     = document.getElementById('session-select');
const sessionActions    = document.getElementById('session-actions');
const chatContainer     = document.getElementById('chat-container');
const dragOverlay       = document.getElementById('drag-overlay');
const ingestionProgress = document.getElementById('ingestion-progress');
const progressTitle     = document.getElementById('progress-title');
const progressCount     = document.getElementById('progress-count');
const progressBarFill   = document.getElementById('progress-bar-fill');
const btnUploadCsv      = document.getElementById('btn-upload-csv');
const csvFileInput      = document.getElementById('csv-file-input');

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

// ── Session Management ──────────────────────────────────────────────

async function populateSessionDropdown() {
  if (!agent) return;
  const sessions = await listSessions(agent.sqlite3, agent.db);
  sessionSelect.innerHTML = '';
  sessions.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === activeSessionId) opt.selected = true;
    sessionSelect.appendChild(opt);
  });
  updateSessionActions();
}

function updateSessionActions() {
  // Disable delete for default session
  const deleteBtn = document.getElementById('session-delete');
  if (deleteBtn) deleteBtn.disabled = (activeSessionId === 'default');
}

sessionSelect.addEventListener('change', async () => {
  activeSessionId = sessionSelect.value;
  activeStreamingBubble = null;
  activeToolIndicator = null;
  await setActiveSession(agent.sqlite3, agent.db, activeSessionId);
  await renderMessages();
  updateSessionActions();
});

sessionActions.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action || !agent) return;

  if (action === 'new') {
    const name = prompt('Session name:', 'New Session');
    if (!name?.trim()) return;
    const id = await createSession(agent.sqlite3, agent.db, name.trim());
    activeSessionId = id;
    activeStreamingBubble = null;
    activeToolIndicator = null;
    await setActiveSession(agent.sqlite3, agent.db, id);
    await populateSessionDropdown();
    await renderMessages();
  }

  if (action === 'delete') {
    if (activeSessionId === 'default') return;
    if (!confirm(`Delete session "${activeSessionId}" and all its messages?`)) return;
    await deleteSession(agent.sqlite3, agent.db, activeSessionId);
    activeSessionId = 'default';
    activeStreamingBubble = null;
    activeToolIndicator = null;
    await setActiveSession(agent.sqlite3, agent.db, 'default');
    await populateSessionDropdown();
    await renderMessages();
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

function renderToolContent(content) {
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
    return renderTable(parsed[0].columns, parsed[0].values);
  }

  // 1b. Single object table format: { columns: [...], values: [...] }
  if (parsed && parsed.columns && parsed.values) {
    return renderTable(parsed.columns, parsed.values);
  }

  // 2. Search web results: { query: '...', results: [{ title, url, snippet }] }
  if (parsed && Array.isArray(parsed.results)) {
    if (!parsed.results.length) return '<em>(no search results found)</em>';
    let html = '<div class="search-results-list">';
    parsed.results.forEach(r => {
      html += `
        <div class="search-result-item">
          <a class="search-result-title" href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title || r.url)}</a>
          <div class="search-result-snippet">${escapeHtml(r.snippet || '')}</div>
        </div>
      `;
    });
    html += '</div>';
    return html;
  }

  // 3. Fetch URL preview: { url, status, title, content }
  if (parsed && parsed.url && (parsed.content !== undefined || parsed.title !== undefined)) {
    let html = '<div class="fetch-url-preview">';
    html += `<div class="fetch-url-title"><strong>${escapeHtml(parsed.title || 'Fetched Page')}</strong> &middot; <a href="${escapeHtml(parsed.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(parsed.url)}</a></div>`;
    if (parsed.content) {
      const preview = parsed.content.length > 600 ? parsed.content.slice(0, 600) + '…' : parsed.content;
      html += `<div class="fetch-url-body">${escapeHtml(preview)}</div>`;
    }
    html += '</div>';
    return html;
  }

  // 4. Tool error: { error: '...' }
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
  let html = `<div class="scratchpad-header">` +
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
  return html;
}

// ── Message Rendering ───────────────────────────────────────────────

async function renderMessages() {
  if (!agent) return;
  const rows = [];
  for await (const stmt of agent.sqlite3.statements(
    agent.db,
    `SELECT id, role, content, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC`
  )) {
    agent.sqlite3.bind_collection(stmt, [activeSessionId]);
    while (await agent.sqlite3.step(stmt) === SQLITE_ROW) {
      rows.push(agent.sqlite3.row(stmt));
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
  rows.forEach(([id, role, content, toolCallId]) => {
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

      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = renderToolContent(content);
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
      contentDiv.innerHTML = renderToolContent(event.result || (event.error ? { error: event.error } : {}));
      div.appendChild(contentDiv);

      messagesEl.appendChild(div);
      scrollChatToBottom();

      statusBar.textContent = '● Received tool result, continuing…';
      statusBar.style.color = '#58a6ff';
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
  if (sessionSelect) sessionSelect.disabled = on;
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

    // T3: attach capture triggers to every user data table (idempotent) and
    // repair orphaned tool_call pairs in EVERY session (a crash mid-cascade can
    // leave an assistant row with tool_calls but no tool row → LLM 400 later).
    try {
      await sweepCaptureTriggers(agent.sqlite3, agent.db);
      const allSessions = await listSessions(agent.sqlite3, agent.db);
      for (const s of allSessions) {
        await repairOrphanedToolCalls(agent.sqlite3, agent.db, s.id);
      }
    } catch (e) {
      console.warn('[main] T3 boot setup failed (non-fatal):', e);
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
    inputEl.focus();
  } catch (e) {
    console.error('[main] Boot failed:', e);
    statusBar.textContent = `⚠ Boot failed: ${e.message}`;
    statusBar.style.color = '#f85149';
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
    await runManualCompaction(compactCmd.instructions);
    return;
  }

  // T9: scratchpad branch — leading bang(s) mean "run this SQL directly",
  // bypassing the LLM trigger cascade entirely.
  const scratch = parseScratchpad(userText);
  if (scratch) {
    inputEl.value = '';
    await runScratchpad(scratch, userText);
    return;
  }

  inputEl.value = '';
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
  if (sessionSelect) sessionSelect.disabled = true;
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
    return { kind: 'forbidden' };
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

    // Transaction control would break the scratchpad savepoint protocol.
    if (cls.kind === 'forbidden') {
      throw new Error(`Transaction-control statements (${text.split(/\s+/)[0]}) cannot run inside the scratchpad savepoint.`);
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
    statusBar.textContent = `✓ Exported ${result.bytes} bytes`;
    statusBar.style.color = '#3fb950';
    setTimeout(() => {
      updateReadyStatus();
    }, 3000);
  } catch (e) {
    console.error('[export]', e);
    // Fallback to SQL dump
    try {
      statusBar.textContent = 'Binary export unavailable, trying SQL dump…';
      await exportSqlDump(agent.sqlite3, agent.db, `bobby-brain-${new Date().toISOString().slice(0, 10)}.sql`);
      statusBar.textContent = '✓ SQL dump exported';
      statusBar.style.color = '#3fb950';
    } catch (e2) {
      console.error('[export sql]', e2);
      statusBar.textContent = `⚠ Export failed: ${e2.message}`;
      statusBar.style.color = '#f85149';
    }
  }
});

document.getElementById('btn-import').addEventListener('click', async () => {
  if (!agent) return;
  if (!confirm('Importing a cartridge will REPLACE your current database. Continue?')) return;
  try {
    statusBar.textContent = 'Importing cartridge…';
    statusBar.style.color = '#d29922';
    // Same DB handle is preserved by importCartridge — UDFs, the update hook,
    // and connection-level pragmas all survive, so nothing to re-register.
    await importCartridge(agent.sqlite3, agent.module, agent.db);

    activeSessionId = 'default';
    await setActiveSession(agent.sqlite3, agent.db, 'default');
    await populateSessionDropdown();
    await renderMessages();
    statusBar.textContent = '✓ Cartridge imported';
    statusBar.style.color = '#3fb950';
    setTimeout(() => {
      updateReadyStatus();
    }, 3000);
  } catch (e) {
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


