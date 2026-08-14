/**
 * MAIN — Entry point. One INSERT triggers the pure-SQL ReAct cascade.
 *
 * Session-aware: messages are partitioned by session_id.
 * UI supports session switching, creation, and deletion.
 */

import { bootSqliteAgent } from './harness.js';
import { setActiveSession, createSession, listSessions, deleteSession, getSessionTokenUsage } from './schema.js';
import { exportCartridge, importCartridge, exportSqlDump } from './cartridge.js';
import { SQLITE_ROW } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
import './styles.css';

const messagesEl     = document.getElementById('messages');
const loadingEl      = document.getElementById('loading');
const formEl         = document.getElementById('input-form');
const inputEl        = document.getElementById('user-input');
const sendBtn        = document.getElementById('send-btn');
const statusBar      = document.getElementById('status-bar');
const configForm     = document.getElementById('config-form');
const configProvider = document.getElementById('config-provider');
const rowConfigUrl   = document.getElementById('row-config-url');
const configUrl      = document.getElementById('config-url');
const configModel    = document.getElementById('config-model');
const configKey      = document.getElementById('config-key');
const labelConfigKey = document.getElementById('label-config-key');
const sessionSelect  = document.getElementById('session-select');
const sessionActions = document.getElementById('session-actions');

let agent = null;
let isProcessing = false;
let activeSessionId = 'default';

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
    await setActiveSession(agent.sqlite3, agent.db, id);
    await populateSessionDropdown();
    await renderMessages();
  }

  if (action === 'delete') {
    if (activeSessionId === 'default') return;
    if (!confirm(`Delete session "${activeSessionId}" and all its messages?`)) return;
    await deleteSession(agent.sqlite3, agent.db, activeSessionId);
    activeSessionId = 'default';
    await setActiveSession(agent.sqlite3, agent.db, 'default');
    await populateSessionDropdown();
    await renderMessages();
  }
});

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

    // Parse tool results as JSON tables when possible
    if (role === 'tool') {
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = '🔧 Tool Output';
      div.prepend(label);
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.columns && parsed.values) {
          div.innerHTML = renderTable(parsed.columns, parsed.values);
        } else {
          div.textContent = content || '[empty]';
        }
      } catch {
        div.textContent = content || '[empty]';
      }
    } else {
      div.textContent = content || '[empty]';
    }

    messagesEl.appendChild(div);
  });

  document.getElementById('chat-container').scrollTop = messagesEl.parentElement.scrollHeight;
  updateTokenUsage();
}

function renderTable(columns, values) {
  if (!values.length) return '<em>(no rows)</em>';
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

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function updateTokenUsage() {
  if (!agent) return;
  const [promptTokens, completionTokens] = await getSessionTokenUsage(agent.sqlite3, agent.db, activeSessionId);
  const tokenEl = document.getElementById('token-usage');
  if (tokenEl) {
    tokenEl.textContent = `Tokens: ${promptTokens} in / ${completionTokens} out`;
  }
}

// ── Processing State ────────────────────────────────────────────────

function setLoading(on) {
  loadingEl.classList.toggle('hidden', !on);
  inputEl.disabled = on;
  sendBtn.disabled = on;
  isProcessing = on;
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

    // Set active session
    activeSessionId = 'default';
    await setActiveSession(agent.sqlite3, agent.db, activeSessionId);

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
  inputEl.value = '';
  setLoading(true);
  await Promise.resolve();

  try {
    // Single INSERT → trigger cascade (JSPI suspends during LLM fetches) → done
    // Message is inserted into the active session
    const sql = `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`;
    for await (const stmt of agent.sqlite3.statements(agent.db, sql)) {
      agent.sqlite3.bind_collection(stmt, [activeSessionId, text.trim()]);
      await agent.sqlite3.step(stmt);
    }

    // Update session's updated_at timestamp
    await agent.sqlite3.exec(agent.db, `UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [activeSessionId]);
  } catch (e) {
    console.error('[main] Cascade error:', e);
    statusBar.textContent = '⚠ Error during agent execution';
    statusBar.style.color = '#f85149';
  }

  setLoading(false);
  await renderMessages();
  inputEl.focus();
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
      statusBar.textContent = '● Ready';
      statusBar.style.color = '#3fb950';
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
    activeSessionId = 'default';
    await setActiveSession(agent.sqlite3, agent.db, 'default');
    await populateSessionDropdown();
    await renderMessages();
    statusBar.textContent = '✓ Cartridge imported';
    statusBar.style.color = '#3fb950';
    setTimeout(() => {
      statusBar.textContent = '● Ready';
      statusBar.style.color = '#3fb950';
    }, 3000);
  } catch (e) {
    console.error('[import]', e);
    statusBar.textContent = `⚠ Import failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
});
