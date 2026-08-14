/**
 * JS HARNESS — wa-sqlite JSPI bridge.
 *
 * Zero agentic logic. Boots wa-sqlite JSPI, registers UDFs, executes schema.
 * The ReAct loop lives entirely in SQL triggers.
 *
 * Session-aware: triggers are scoped per-session via `NEW.session_id`.
 * Token tracking: ask_llm returns prompt_tokens + completion_tokens.
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
  //    Now returns token counts alongside content and tool_calls.
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

        // Extract token usage from response (OpenAI-compatible format)
        const usage = data.usage || {};
        const promptTokens = usage.prompt_tokens || usage.prompt_tokens_details?.cached_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;

        sqlite3.result_text(context, JSON.stringify({
          content: msg.content || '',
          tool_calls: msg.tool_calls || null,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        }));
      } catch (e) {
        console.error('[ask_llm]', e);
        sqlite3.result_text(context, JSON.stringify({
          content: `⚠ SYSTEM ERROR: ${e.message}`,
          prompt_tokens: 0,
          completion_tokens: 0,
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

  // 7. Register async UDF: search_web (web search via configured provider)
  await sqlite3.create_function(
    db, 'search_web', 1, SQLITE_UTF8, null,
    async (context, args) => {
      try {
        const query = sqlite3.value_text(args[0]);
        if (!query) {
          sqlite3.result_text(context, JSON.stringify({ error: 'Empty search query' }));
          return;
        }

        // Use DuckDuckGo Lite API as default (no API key needed)
        // Can be overridden with a custom search endpoint in system_config
        const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        const resp = await fetch(searchUrl, {
          headers: { 'Accept': 'application/json' },
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        const results = [];
        // Extract related topics as search results
        if (data.RelatedTopics) {
          for (const topic of data.RelatedTopics.slice(0, 8)) {
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: topic.Text.split('. ')[0] || topic.Text.slice(0, 80),
                url: topic.FirstURL,
                snippet: topic.Text.slice(0, 200),
              });
            } else if (topic.Topics) {
              // Nested topics
              for (const sub of topic.Topics.slice(0, 3)) {
                if (sub.Text && sub.FirstURL) {
                  results.push({
                    title: sub.Text.split('. ')[0] || sub.Text.slice(0, 80),
                    url: sub.FirstURL,
                    snippet: sub.Text.slice(0, 200),
                  });
                }
              }
            }
          }
        }

        // Add abstract if available
        if (data.AbstractText && data.AbstractURL) {
          results.unshift({
            title: data.Heading || query,
            url: data.AbstractURL,
            snippet: data.AbstractText.slice(0, 300),
          });
        }

        sqlite3.result_text(context, JSON.stringify({
          query,
          results: results.slice(0, 10),
        }));
      } catch (e) {
        console.error('[search_web]', e);
        sqlite3.result_text(context, JSON.stringify({ error: e.message }));
      }
    }
  );

  // 8. Register async UDF: fetch_url (fetch web page content with SSRF protection)
  await sqlite3.create_function(
    db, 'fetch_url', 1, SQLITE_UTF8, null,
    async (context, args) => {
      try {
        const url = sqlite3.value_text(args[0]);
        if (!url) {
          sqlite3.result_text(context, JSON.stringify({ error: 'Empty URL' }));
          return;
        }

        // SSRF protection: block private/internal IPs
        const blockedPatterns = [
          /^localhost$/i, /^127\./, /^10\./, /^192\.168\./,
          /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^::1$/,
          /^fc00:/i, /^fe80:/i,
        ];

        let parsedUrl;
        try {
          parsedUrl = new URL(url);
        } catch {
          sqlite3.result_text(context, JSON.stringify({ error: 'Invalid URL format' }));
          return;
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          sqlite3.result_text(context, JSON.stringify({ error: 'Only HTTP/HTTPS protocols allowed' }));
          return;
        }

        for (const pattern of blockedPatterns) {
          if (pattern.test(parsedUrl.hostname)) {
            sqlite3.result_text(context, JSON.stringify({
              error: `Access to '${parsedUrl.hostname}' is blocked (private/internal address)`,
            }));
            return;
          }
        }

        const resp = await fetch(url, {
          headers: { 'User-Agent': 'WebSQLAgent/1.0' },
          signal: AbortSignal.timeout(10000), // 10s timeout
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();

        // Strip HTML tags for readable text
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000); // Cap at 8000 chars

        sqlite3.result_text(context, JSON.stringify({
          url,
          status: resp.status,
          title: html.match(/<title>(.*?)<\/title>/i)?.[1] || '(no title)',
          content: text,
          truncated: html.length > 8000,
        }));
      } catch (e) {
        console.error('[fetch_url]', e);
        sqlite3.result_text(context, JSON.stringify({ error: e.message }));
      }
    }
  );

  // 9. Initialize schema (tables + triggers + sample data)
  await sqlite3.exec(db, SCHEMA_SQL);

  console.log('[harness] Agent booted (wa-sqlite JSPI). LLM:', llmUrl || '(none)');
  return { sqlite3, db };
}
