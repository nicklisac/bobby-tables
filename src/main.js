/**
 * MAIN — Entry point. One INSERT triggers the pure-SQL ReAct cascade.
 *
 * [T26.3: slimmed to the orchestrator — boot, turn dispatch (sendMessage),
 * config, theme, and the T2/T3 turn-lifecycle glue. Chat rendering, the
 * scratchpad engine, the sessions pane, and the cartridge/CSV UI glue moved
 * to chat-render.js, scratchpad.js, sessions-ui.js, rewind.js, cartridge.js,
 * csv-ingestion.js — pure code moves, no behavior change.]
 */

import { bootSqliteAgent, beginTurn, requestStop, endTurn, isStopRequested } from './harness.js';
import {
  setActiveSession, listSessions,
  sweepCaptureTriggers, repairOrphanedToolCalls, evictChangesets, setSuppressCascade,
  setSuppressCapture,
  execParams, queryAll,
  assertProtectedTablesInvariant,
} from './schema.js';
import {
  runCompaction, estimateActiveContextTokens, resolveContextWindow,
  COMPACTION_THRESHOLD, FALLBACK_WINDOW,
} from './compaction.js';
import { rewindToBefore, initRewindUi } from './rewind.js';
import { initCartridgeUi } from './cartridge.js';
import { initCsvUi } from './csv-ingestion.js';
import * as gridUi from './grid-ui.js';
import * as gridEngine from './grid.js';
import * as explorerEngine from './explorer.js';
import * as explorerUi from './explorer-ui.js';
import { initPaneResizers } from './panes.js';
import { SqlAutocompleteController, globalSchemaIndex } from './sql-autocomplete.js';
import {
  initChatRender, renderMessages, setLoading, setSendButtonStop,
  updateReadyStatus, scrollChatToBottom, isBusy, startEventStreamListener,
  resetStreamingState,
} from './chat-render.js';
import {
  initScratchpad, parseScratchpad, runScratchpad, rewindToBeforeScratchpad,
} from './scratchpad.js';
import { initSessionsUi, populateSessionDropdown } from './sessions-ui.js';
import { initDocumentsUi } from './documents-ui.js';
import * as documentsLib from './documents.js';
import { ICONS } from './icons.js';
import './styles.css';

const messagesEl        = document.getElementById('messages');
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
const btnToggleConfig   = document.getElementById('btn-toggle-config');
const configModal       = document.getElementById('config-modal');
const configCancel      = document.getElementById('config-cancel');
const configCloseBtn    = document.getElementById('config-close-btn');

let agent = null;
let activeSessionId = 'default';

// ── Day / Night Theme Management ─────────────────────────────────────

export function initTheme() {
  const saved = localStorage.getItem('bobby-tables-theme');
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (systemPrefersDark ? 'dark' : 'light');
  setTheme(theme, false);

  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    const curr = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = curr === 'dark' ? 'light' : 'dark';
    setTheme(next, true);
  });

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('bobby-tables-theme')) {
        setTheme(e.matches ? 'dark' : 'light', false);
      }
    });
  }
}

export function setTheme(theme, save = true) {
  document.documentElement.setAttribute('data-theme', theme);
  if (save) {
    localStorage.setItem('bobby-tables-theme', theme);
  }
  const iconSvg = document.getElementById('theme-mode-icon');
  if (iconSvg) {
    if (theme === 'dark') {
      // In dark mode, show Sun icon (click to switch to light)
      iconSvg.innerHTML = `
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line>
        <line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line>
        <line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      `;
      document.getElementById('btn-theme-toggle')?.setAttribute('title', 'Switch to Day Mode (Light)');
    } else {
      // In light mode, show Moon icon (click to switch to dark)
      iconSvg.innerHTML = `
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      `;
      document.getElementById('btn-theme-toggle')?.setAttribute('title', 'Switch to Night Mode (Dark)');
    }
  }
}

// ── Config Persistence ──────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(localStorage.getItem('sql-agent-config') || '{}'); } catch { return {}; }
}

function saveConfig(c) {
  localStorage.setItem('sql-agent-config', JSON.stringify(c));
}

function isProviderConfigured(cfg = loadConfig()) {
  if (cfg && cfg.isConfigured) return true;
  if (!cfg || !cfg.provider) return false;
  if (cfg.provider === 'gemini') return Boolean(cfg.apiKey && cfg.apiKey.trim());
  if (cfg.provider === 'openai') {
    return Boolean((cfg.url && cfg.url.trim()) || (cfg.apiKey && cfg.apiKey.trim()));
  }
  return false;
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
  else configProvider.value = 'gemini';
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
  setTimeout(() => {
    if (configProvider.value === 'gemini' && configKey) {
      configKey.focus();
    } else {
      configModel?.focus();
    }
  }, 50);
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
      isConfigured: true,
    });
    closeConfigModal();
    statusBar.textContent = 'Configuration saved. Rebooting…';
    await bootAgent();
  });
}

// ── Boot ────────────────────────────────────────────────────────────

async function bootAgent() {
  const cfg = loadConfig();
  const provider = cfg.provider || 'gemini';
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

    await populateSessionDropdown();
    await renderMessages();

    // T11: 3-pane workstation — render the 3×3 dashboard grid (right pane),
    // the DB Explorer table list (left pane), and attach the data_change
    // reactivity stream. Expose the grid engine on the live handle for probes.
    try {
      window.__agent.grid = gridEngine;
      window.__agent.gridUi = gridUi;
      await gridUi.initGridUi(agent);
    } catch (e) {
      console.warn('[main] T11 grid init failed (non-fatal):', e);
    }

    // T8: DB Schema Inspector & Explorer
    try {
      window.__agent.explorer = explorerEngine;
      window.__agent.explorerUi = explorerUi;
      window.__agent.renderMessages = renderMessages;
      await explorerUi.initExplorerUi(agent);
    } catch (e) {
      console.warn('[main] T8 explorer init failed (non-fatal):', e);
    }

    // T16: Documents corpus pane (FTS5 full-text search)
    try {
      window.__agent.documents = documentsLib;
      await initDocumentsUi({ getAgent: () => agent });
    } catch (e) {
      console.warn('[main] T16 documents init failed (non-fatal):', e);
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

    updateReadyStatus();
    window.__agent.ready = true;
    inputEl.disabled = false;
    sendBtn.disabled = false;
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
  const cardEl = document.getElementById('chat-input-card');
  if (!badgeEl || !inputEl) return;

  if (bang && bang.isBang) {
    badgeEl.classList.remove('hidden');
    badgeEl.classList.toggle('bang-private', bang.isPrivate);
    const iconSpan = badgeEl.querySelector('.bang-badge-icon');
    const textSpan = badgeEl.querySelector('.bang-badge-text');
    if (iconSpan) {
      iconSpan.innerHTML = bang.isPrivate ? ICONS.lock({ size: 12 }) : ICONS.terminal({ size: 12 });
    }
    if (textSpan) {
      textSpan.textContent = bang.isPrivate ? 'Private SQL' : 'SQL';
    }

    inputEl.classList.add('bang-mode');
    inputEl.classList.add('has-bang-badge');
    inputEl.classList.toggle('bang-private', bang.isPrivate);
    if (cardEl) {
      cardEl.classList.toggle('bang-private', bang.isPrivate);
    }
    
    // Dynamically calculate left padding so bangs and SQL text never impinge or overlap the badge
    const badgeWidth = badgeEl.offsetWidth || (bang.isPrivate ? 95 : 55);
    inputEl.style.paddingLeft = `${badgeWidth + 10}px`;

    inputEl.placeholder = bang.isPrivate
      ? 'Enter private SQL (hidden from agent context)…'
      : 'Enter SQL to execute directly (visible to agent)…';
  } else {
    badgeEl.classList.add('hidden');
    badgeEl.classList.remove('bang-private');
    inputEl.classList.remove('bang-mode', 'has-bang-badge', 'bang-private');
    if (cardEl) {
      cardEl.classList.remove('bang-private');
      cardEl.classList.remove('bang-mode');
    }
    inputEl.style.paddingLeft = '';
    inputEl.placeholder = 'Ask Tables to analyze data… or run SQL: ! = agent sees it, !! = private';
  }
}

// ── Send Message ────────────────────────────────────────────────────

async function sendMessage(text) {
  if (isBusy() || !agent || !text.trim()) return;
  const userText = text.trim();

  // T2: manual compaction — /compact [instructions] (input interception, same
  // path as T9's bang commands; a command, not a message — never stored).
  const compactCmd = parseCompactCommand(userText);
  if (compactCmd) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateBangModeVisuals({ isBang: false });
    await runManualCompaction(compactCmd.instructions);
    return;
  }

  // T9: scratchpad branch — leading bang(s) mean "run this SQL directly",
  // bypassing the LLM trigger cascade entirely.
  const scratch = parseScratchpad(userText);
  if (scratch) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateBangModeVisuals({ isBang: false });
    await runScratchpad(scratch, userText);
    return;
  }

  // Check if LLM provider is configured before attempting AI chat turns
  if (!isProviderConfigured(loadConfig())) {
    openConfigModal();
    statusBar.textContent = '○ Please configure an LLM provider in ⚙ Config before chatting';
    statusBar.style.color = '#d29922';
    return;
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  updateBangModeVisuals({ isBang: false });
  setLoading(true);
  setSendButtonStop(true); // T3: morph Send → Stop while the turn is in flight

  // Optimistically render user message immediately
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.textContent = userText;
  userDiv.title = new Date().toLocaleString();
  messagesEl.appendChild(userDiv);
  scrollChatToBottom();

  resetStreamingState();

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

// ── Event Listeners ─────────────────────────────────────────────────

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(inputEl.value);
});

// Support Shift+Enter for newlines vs Enter for submit on textarea
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // If autocomplete dropdown is open, let autocomplete handle Enter
    if (mainAutocomplete && mainAutocomplete.isOpen) return;
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

// Auto-grow textarea height on multiline input
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, 48), 180) + 'px';
});

// T3: when the Send button has morphed into Stop, a click aborts the in-flight
// turn instead of submitting a new message.
sendBtn.addEventListener('click', (e) => {
  if (sendBtn.dataset.mode === 'stop') {
    e.preventDefault();
    requestStop();
  }
});

// ── Module wiring (T26.3) ───────────────────────────────────────────
//
// The extracted modules read mutable main.js state through these getters and
// call back into each other through stable function references. All inits run
// before bootAgent(), so every callback target exists by the time a user
// action can fire.

initChatRender({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  getConfig: loadConfig,
  isConfigured: isProviderConfigured,
  onConfigClick: () => openConfigModal(),
  onRewindTurn: (id) => rewindToBefore(id),
  onRewindScratchpad: (id) => rewindToBeforeScratchpad(id),
});
initRewindUi({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  isBusy,
  renderMessages,
  updateReadyStatus,
});
initScratchpad({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  isBusy,
  setLoading,
  renderMessages,
  updateReadyStatus,
  scrollChatToBottom,
  flushCards: () => gridUi.flushCards(),
});
initSessionsUi({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  setSessionId: (id) => { activeSessionId = id; },
});
initCartridgeUi({
  getAgent: () => agent,
  setSessionId: (id) => { activeSessionId = id; },
  updateReadyStatus,
});
initCsvUi({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  isBusy,
  setLoading,
});

// ── Boot ────────────────────────────────────────────────────────────

populateConfigForm();
bootAgent();

// Initialize Day/Night Theme
initTheme();

// T11 follow-up: draggable dividers between the 3 panes
initPaneResizers();
