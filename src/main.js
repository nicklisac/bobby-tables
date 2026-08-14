/**
 * MAIN — Entry point. One INSERT triggers the pure-SQL ReAct cascade.
 *
 * Session-aware: messages are partitioned by session_id.
 * UI supports session switching, creation, and deletion.
 * Live Event Streaming: renders tokens, tool execution indicators, and results in real time.
 */

import { bootSqliteAgent, getEventStream } from './harness.js';
import { setActiveSession, createSession, listSessions, deleteSession, getSessionTokenUsage } from './schema.js';
import { exportCartridge, importCartridge, exportSqlDump } from './cartridge.js';
import { ingestCsvToSqlite } from './csv-ingestion.js';
import { SQLITE_ROW } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
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

// ── Message Rendering ───────────────────────────────────────────────

async function renderMessages() {
  if (!agent) return;
  const rows = [];
  for await (const stmt of agent.sqlite3.statements(
    agent.db,
    `SELECT role, content, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC`
  )) {
    agent.sqlite3.bind_collection(stmt, [activeSessionId]);
    while (await agent.sqlite3.step(stmt) === SQLITE_ROW) {
      rows.push(agent.sqlite3.row(stmt));
    }
  }

  messagesEl.innerHTML = '';
  rows.forEach(([role, content, toolCallId]) => {
    if (role === 'system') return;
    const div = document.createElement('div');
    div.className = `message ${role}`;

    if (role === 'tool') {
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = '🔧 Tool Output';
      div.appendChild(label);

      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = renderToolContent(content);
      div.appendChild(contentDiv);
    } else {
      div.textContent = content || '[empty]';
    }

    messagesEl.appendChild(div);
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
  isProcessing = on;
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

    // Start event stream listener
    startEventStreamListener();

    // Set active session
    activeSessionId = 'default';
    await setActiveSession(agent.sqlite3, agent.db, activeSessionId);

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
  inputEl.value = '';
  setLoading(true);

  // Optimistically render user message immediately
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.textContent = userText;
  messagesEl.appendChild(userDiv);
  scrollChatToBottom();

  activeStreamingBubble = null;
  activeToolIndicator = null;

  try {
    // Single INSERT → trigger cascade (JSPI suspends during LLM fetches & streaming) → done
    const sql = `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`;
    for await (const stmt of agent.sqlite3.statements(agent.db, sql)) {
      agent.sqlite3.bind_collection(stmt, [activeSessionId, userText]);
      await agent.sqlite3.step(stmt);
    }

    // Update session's updated_at timestamp
    await agent.sqlite3.exec(agent.db, `UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [activeSessionId]);

    // Emit 'done' event
    agent.eventStream?.emit('done', { sessionId: activeSessionId });
  } catch (e) {
    console.error('[main] Cascade error:', e);
    agent.eventStream?.emit('error', { error: e.message });
    statusBar.textContent = `⚠ Error: ${e.message}`;
    statusBar.style.color = '#f85149';
  } finally {
    setLoading(false);
    // Reconcile and finalize state with SQLite database
    await renderMessages();
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    updateReadyStatus();
  }
}

// ── Event Listeners ─────────────────────────────────────────────────

formEl.addEventListener('submit', e => { e.preventDefault(); sendMessage(inputEl.value); });

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
    const result = await exportCartridge(agent.sqlite3, agent.db, `bobby-brain-${new Date().toISOString().slice(0, 10)}.sqlite3`);
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
    const newDb = await importCartridge(agent.sqlite3, 'agent_brain.sqlite3', 'idb');
    agent.db = newDb;

    // Re-register update hook on imported DB
    agent.sqlite3.update_hook(newDb, (iUpdateType, dbNameStr, tblName, rowid) => {
      if (tblName === 'messages' && iUpdateType === 18 /* SQLITE_INSERT */) {
        agent.eventStream?.emit('react_step', {
          table: tblName,
          action: 'INSERT',
          rowid: typeof rowid === 'bigint' ? Number(rowid) : rowid,
          dbName: dbNameStr,
        });
      }
    });

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


