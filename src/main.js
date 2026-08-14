/**
 * MAIN — Entry point. One INSERT triggers the pure-SQL ReAct cascade.
 */

import { bootSqliteAgent } from './harness.js';
import './styles.css';

const messagesEl = document.getElementById('messages');
const loadingEl  = document.getElementById('loading');
const formEl     = document.getElementById('input-form');
const inputEl    = document.getElementById('user-input');
const sendBtn    = document.getElementById('send-btn');
const statusBar  = document.getElementById('status-bar');
const configForm = document.getElementById('config-form');
const configProvider = document.getElementById('config-provider');
const configUrl    = document.getElementById('config-url');
const configModel  = document.getElementById('config-model');
const configKey    = document.getElementById('config-key');

let agent = null;
let isProcessing = false;

function loadConfig() { try { return JSON.parse(localStorage.getItem('sql-agent-config') || '{}'); } catch { return {}; } }
function saveConfig(c) { localStorage.setItem('sql-agent-config', JSON.stringify(c)); }
function populateConfigForm() { const c = loadConfig(); if(c.provider) configProvider.value=c.provider; if(c.url) configUrl.value=c.url; if(c.model) configModel.value=c.model; if(c.apiKey) configKey.value=c.apiKey; }

async function renderMessages() {
  if (!agent) return;
  const rows = [];
  await agent.sqlite3.exec(agent.db, 'SELECT role, content FROM agent_memory ORDER BY id ASC', (row) => rows.push(row));
  messagesEl.innerHTML = '';
  rows.forEach(([role, content]) => {
    if (role === 'system') return;
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = content || '[empty]';
    if (role === 'tool_result') { const l = document.createElement('div'); l.className='message-label'; l.textContent='🔧 Tool Output'; div.prepend(l); }
    messagesEl.appendChild(div);
  });
  document.getElementById('chat-container').scrollTop = messagesEl.parentElement.scrollHeight;
}

function setLoading(on) { loadingEl.classList.toggle('hidden', !on); inputEl.disabled = on; sendBtn.disabled = on; isProcessing = on; }

async function bootAgent() {
  const cfg = loadConfig();
  try {
    statusBar.textContent = 'Initializing wa-sqlite JSPI…';
    agent = await bootSqliteAgent({
      dbName: 'agent_brain.sqlite3',
      llmUrl: cfg.url || '',
      llmModel: cfg.model || 'gemini-2.5-flash',
      llmApiKey: cfg.apiKey || '',
      llmProvider: cfg.provider || 'openai',
    });
    const label = cfg.url ? `● Ready — ${cfg.provider} at ${cfg.url}` : '○ Ready — configure LLM to start';
    statusBar.textContent = label;
    statusBar.style.color = cfg.url ? '#3fb950' : '#8b949e';
    inputEl.disabled = false; sendBtn.disabled = false;
    await renderMessages(); inputEl.focus();
  } catch (e) {
    console.error('[main] Boot failed:', e);
    statusBar.textContent = `⚠ Boot failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
}

async function sendMessage(text) {
  if (isProcessing || !agent || !text.trim()) return;
  inputEl.value = ''; setLoading(true);
  await Promise.resolve();
  try {
    // Single INSERT → trigger cascade (JSPI suspends during LLM fetches) → done
    for await (const stmt of agent.sqlite3.statements(agent.db, "INSERT INTO agent_memory (role, content) VALUES ('user', ?)")) {
      agent.sqlite3.bind_collection(stmt, [text.trim()]);
      await agent.sqlite3.step(stmt);
    }
  } catch (e) {
    console.error('[main] Cascade error:', e);
    statusBar.textContent = '⚠ Error during agent execution';
    statusBar.style.color = '#f85149';
  }
  setLoading(false); await renderMessages(); inputEl.focus();
}

formEl.addEventListener('submit', e => { e.preventDefault(); sendMessage(inputEl.value); });
configForm.addEventListener('submit', e => {
  e.preventDefault();
  saveConfig({ provider: configProvider.value, url: configUrl.value.trim(), model: configModel.value.trim(), apiKey: configKey.value.trim() });
  document.getElementById('config-details').open = false;
  bootAgent();
});

populateConfigForm();
bootAgent();
