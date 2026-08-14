/**
 * JS HARNESS — wa-sqlite JSPI bridge.
 *
 * Zero agentic logic. Boots wa-sqlite JSPI, registers UDFs, executes schema.
 * The ReAct loop lives entirely in SQL triggers.
 */

import ModuleFactory from '../vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs';
import { Factory } from '../vendor/wa-sqlite-jspi/sqlite-api.js';
import { SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_UTF8, SQLITE_ROW } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
import { IDBBatchAtomicVFS } from '../vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js';
import { MemoryVFS } from '../vendor/wa-sqlite-jspi/MemoryVFS.js';
import { SCHEMA_SQL } from './schema.js';

export async function bootSqliteAgent(config = {}) {
  const {
    dbName      = 'agent_brain.sqlite3',
    llmUrl      = '',
    llmModel    = 'gemini-2.5-flash',
    llmApiKey   = '',
    llmProvider = 'openai',
  } = config;

  if (!llmUrl) console.warn('[harness] No LLM URL configured.');

  // 1. Boot wa-sqlite JSPI engine
  const module = await ModuleFactory();
  const sqlite3 = Factory(module);

  // 2. Mount VFS (IDB for persistence on main thread, MemoryVFS as fallback)
  // OPFSAdaptiveVFS requires sync access handles which are Worker-only.
  // IDBBatchAtomicVFS works on main thread with IndexedDB persistence.
  let vfsName = '';
  try {
    const vfs = await IDBBatchAtomicVFS.create('idb', module);
    sqlite3.vfs_register(vfs, true);
    vfsName = 'idb';
    console.log('[harness] IDB VFS mounted (persistent)');
  } catch (e) {
    console.warn('[harness] IDB unavailable (', e.message, '), using MemoryVFS');
    const memVfs = await MemoryVFS.create('mem', module);
    sqlite3.vfs_register(memVfs, true);
    vfsName = 'mem';
  }

  // 3. Open database
  const db = await sqlite3.open_v2(dbName,
    SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE, vfsName);

  // 4. Enable recursive triggers
  await sqlite3.exec(db, 'PRAGMA recursive_triggers = ON;');

  // 5. Register async UDF: ask_llm (JSPI suspends WASM during fetch)
  await sqlite3.create_function(
    db, 'ask_llm', 2, SQLITE_UTF8, null,
    async (context, args) => {
      try {
        const contextJson = sqlite3.value_text(args[0]);
        const toolsJson = sqlite3.value_text(args[1]);
        const messages = JSON.parse(contextJson);
        const tools = JSON.parse(toolsJson);

        const cleanMessages = messages.map(m => {
          const c = { role: m.role, content: m.content ?? '' };
          if (m.tool_calls) c.tool_calls = m.tool_calls;
          if (m.tool_call_id) c.tool_call_id = m.tool_call_id;
          return c;
        });

        const resp = await fetch(llmUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(llmApiKey ? { Authorization: `Bearer ${llmApiKey}` } : {}),
          },
          body: JSON.stringify({ model: llmModel, messages: cleanMessages, tools, stream: false }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const msg = data.message || data.choices?.[0]?.message || {};
        sqlite3.result_text(context, JSON.stringify({
          content: msg.content || '',
          tool_calls: msg.tool_calls || null,
        }));
      } catch (e) {
        console.error('[ask_llm]', e);
        sqlite3.result_text(context, JSON.stringify({
          content: `⚠ SYSTEM ERROR: ${e.message}`,
        }));
      }
    }
  );

  // 6. Register async UDF: run_dynamic_sql (JSPI suspends WASM during query execution)
  await sqlite3.create_function(
    db, 'run_dynamic_sql', 1, SQLITE_UTF8, null,
    async (context, args) => {
      try {
        const sql = sqlite3.value_text(args[0]);
        if (!sql) {
          sqlite3.result_text(context, JSON.stringify({ error: 'Empty query' }));
          return;
        }
        const t = sql.trim().toUpperCase();
        if (!t.startsWith('SELECT') && !t.startsWith('WITH')) {
          sqlite3.result_text(context, JSON.stringify({ error: 'Only SELECT queries allowed' }));
          return;
        }
        const rows = [];
        let cols = [];
        for await (const stmt of sqlite3.statements(db, sql)) {
          cols = sqlite3.column_names(stmt);
          while (await sqlite3.step(stmt) === SQLITE_ROW) {
            rows.push(sqlite3.row(stmt));
          }
        }
        sqlite3.result_text(context, JSON.stringify([{
          columns: cols,
          values: rows,
        }]));
      } catch (e) {
        sqlite3.result_text(context, JSON.stringify({ error: e.message }));
      }
    }
  );

  // 7. Initialize schema (tables + triggers + sample data)
  await sqlite3.exec(db, SCHEMA_SQL);

  console.log('[harness] Agent booted (wa-sqlite JSPI). LLM:', llmUrl || '(none)');
  return { sqlite3, db };
}
