/**
 * JS HARNESS — wa-sqlite JSPI bridge.
 *
 * Zero agentic logic. Boots wa-sqlite JSPI, registers UDFs, executes schema.
 * The ReAct loop lives entirely in SQL triggers.
 *
 * Session-aware: triggers are scoped per-session via `NEW.session_id`.
 * Token tracking: ask_llm returns prompt_tokens + completion_tokens.
 *
 * LLM transport: raw fetch() to OpenAI-compatible or Gemini endpoints.
 * Structured output enforced via system prompt + JSON parsing.
 */

import ModuleFactory from '../vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs';
import { Factory } from '../vendor/wa-sqlite-jspi/sqlite-api.js';
import { SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_UTF8, SQLITE_ROW } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
import { IDBBatchAtomicVFS } from '../vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js';
import { MemoryVFS } from '../vendor/wa-sqlite-jspi/MemoryVFS.js';
import { SCHEMA_SQL } from './schema.js';

/**
 * Build the system prompt with tool definitions and structured output instructions.
 */
export function buildSystemPrompt(tools = [], basePrompt = '') {
  let prompt = basePrompt ||
    'You are an autonomous SQL-driven data analyst agent. You have access to a SQLite database and can execute SELECT queries to analyze data. ' +
    'Always write correct, safe, read-only SQL. Think step by step. ' +
    'If the user asks something you cannot answer with available data, say so honestly.';

  if (tools && tools.length > 0) {
    prompt += '\n\n# AVAILABLE TOOLS\n';
    prompt += 'You can call tools by returning a JSON object with a "tool_calls" array.\n';
    for (const t of tools) {
      const schema = typeof t === 'string' ? JSON.parse(t) : t;
      const fn = schema.function || schema;
      prompt += `\n## ${fn.name}\n${fn.description || ''}\nParameters: ${JSON.stringify(fn.parameters || {})}\n`;
    }
    prompt += '\n\n# OUTPUT FORMAT\n';
    prompt += 'Always respond with valid JSON in this exact format:\n';
    prompt += '  {"content": "your response text here", "tool_calls": null}\n';
    prompt += 'Or when calling a tool:\n';
    prompt += '  {"content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "tool_name", "arguments": {"arg": "value"}}}]}\n';
    prompt += '\nIMPORTANT: Your entire response must be valid JSON. Do not include markdown code fences or any text outside the JSON object.';
  }

  return prompt;
}

/**
 * Format conversation history for the LLM API.
 */
export function formatMessages(messages = []) {
  return messages.map(m => {
    const msg = { role: m.role === 'tool' ? 'tool' : m.role, content: m.content || '' };
    if (m.role === 'assistant' && m.tool_calls) {
      msg.tool_calls = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    return msg;
  });
}

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

        // Build system prompt with tool definitions
        const systemMsg = messages.find(m => m.role === 'system');
        const systemPrompt = buildSystemPrompt(tools, systemMsg?.content);

        // Format messages for API
        const apiMessages = [
          { role: 'system', content: systemPrompt },
          ...formatMessages(messages.filter(m => m.role !== 'system'))
        ];

        const resp = await fetch(llmUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(llmApiKey ? { Authorization: `Bearer ${llmApiKey}` } : {}),
          },
          body: JSON.stringify({
            model: llmModel,
            messages: apiMessages,
            tools: tools.length ? tools.map(t => {
              const schema = typeof t === 'string' ? JSON.parse(t) : t;
              return schema;
            }) : undefined,
            stream: false,
          }),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
        const data = await resp.json();
        const msg = data.choices?.[0]?.message || data.message || {};

        // Extract token usage
        const usage = data.usage || {};
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;

        // Parse structured JSON from content if the model wrapped it
        let content = msg.content || '';
        let toolCalls = msg.tool_calls || null;

        // If the model returned JSON in content instead of using native tool_calls, parse it
        if (!toolCalls && content) {
          let parsed = null;
          try {
            // Try parsing directly
            parsed = JSON.parse(content.trim());
          } catch {
            // Try stripping markdown code fences
            const stripped = content.trim()
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/\s*```$/i, '');
            try { parsed = JSON.parse(stripped); } catch {}
          }
          if (parsed) {
            content = parsed.content || content;
            if (parsed.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
              // Normalize to OpenAI tool_calls format
              toolCalls = parsed.tool_calls.map((tc, i) => ({
                id: tc.id || `call_${Date.now()}_${i}`,
                type: 'function',
                function: {
                  name: tc.function?.name || tc.name || '',
                  arguments: typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
                },
              }));
            }
          }
        }

        sqlite3.result_text(context, JSON.stringify({
          content: content || '',
          tool_calls: toolCalls || null,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        }));
      } catch (e) {
        console.error('[ask_llm]', e);
        sqlite3.result_text(context, JSON.stringify({
          content: `⚠ SYSTEM ERROR: ${e.message}`,
          tool_calls: null,
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

  // 7. Register async UDF: search_web (web search via DuckDuckGo)
  await sqlite3.create_function(
    db, 'search_web', 1, SQLITE_UTF8, null,
    async (context, args) => {
      try {
        const query = sqlite3.value_text(args[0]);
        if (!query) {
          sqlite3.result_text(context, JSON.stringify({ error: 'Empty search query' }));
          return;
        }
        const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        const resp = await fetch(searchUrl, { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const results = [];
        if (data.RelatedTopics) {
          for (const topic of data.RelatedTopics.slice(0, 8)) {
            if (topic.Text && topic.FirstURL) {
              results.push({ title: topic.Text.split('. ')[0] || topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text.slice(0, 200) });
            } else if (topic.Topics) {
              for (const sub of topic.Topics.slice(0, 3)) {
                if (sub.Text && sub.FirstURL) {
                  results.push({ title: sub.Text.split('. ')[0] || sub.Text.slice(0, 80), url: sub.FirstURL, snippet: sub.Text.slice(0, 200) });
                }
              }
            }
          }
        }
        if (data.AbstractText && data.AbstractURL) {
          results.unshift({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText.slice(0, 300) });
        }
        sqlite3.result_text(context, JSON.stringify({ query, results: results.slice(0, 10) }));
      } catch (e) {
        console.error('[search_web]', e);
        sqlite3.result_text(context, JSON.stringify({ error: e.message }));
      }
    }
  );

  // 8. Register async UDF: fetch_url (with SSRF protection)
  await sqlite3.create_function(
    db, 'fetch_url', 1, SQLITE_UTF8, null,
    async (context, args) => {
      try {
        const url = sqlite3.value_text(args[0]);
        if (!url) { sqlite3.result_text(context, JSON.stringify({ error: 'Empty URL' })); return; }
        const blocked = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^::1$/, /^fc00:/i, /^fe80:/i];
        let parsedUrl;
        try { parsedUrl = new URL(url); } catch { sqlite3.result_text(context, JSON.stringify({ error: 'Invalid URL' })); return; }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) { sqlite3.result_text(context, JSON.stringify({ error: 'Only HTTP/HTTPS allowed' })); return; }
        for (const p of blocked) {
          if (p.test(parsedUrl.hostname)) { sqlite3.result_text(context, JSON.stringify({ error: `Blocked: ${parsedUrl.hostname}` })); return; }
        }
        const resp = await fetch(url, { headers: { 'User-Agent': 'WebSQLAgent/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        sqlite3.result_text(context, JSON.stringify({ url, status: resp.status, title: html.match(/<title>(.*?)<\/title>/i)?.[1] || '(no title)', content: text, truncated: html.length > 8000 }));
      } catch (e) {
        console.error('[fetch_url]', e);
        sqlite3.result_text(context, JSON.stringify({ error: e.message }));
      }
    }
  );

  // 9. Initialize schema
  await sqlite3.exec(db, SCHEMA_SQL);

  // 10. Schema migration: detect old agent_memory table and migrate
  try {
    let agentMemoryCount = 0;
    for await (const stmt of sqlite3.statements(db, `SELECT COUNT(*) FROM agent_memory`)) {
      if (await sqlite3.step(stmt) === SQLITE_ROW) agentMemoryCount = sqlite3.column_int(stmt, 0);
    }
    if (agentMemoryCount > 0) {
      console.warn(`[harness] Legacy agent_memory table detected (${agentMemoryCount} rows) — migrating`);
      await sqlite3.exec(db, 'DROP TRIGGER IF EXISTS agent_think;');
      await sqlite3.exec(db, 'DROP TRIGGER IF EXISTS execute_tool;');
      await sqlite3.exec(db, `INSERT OR IGNORE INTO messages (id, session_id, role, content, tool_calls, tool_call_id, created_at) SELECT id, 'default', CASE WHEN role='tool_result' THEN 'tool' ELSE role END, content, tool_calls, tool_call_id, created_at FROM agent_memory;`);
      await sqlite3.exec(db, 'DROP TABLE IF EXISTS agent_memory;');
      console.log('[harness] Migration complete');
    }
  } catch (e) {
    if (!e.message?.includes('agent_memory')) console.warn('[harness] Migration error (non-fatal):', e.message);
  }

  console.log('[harness] Agent booted (wa-sqlite JSPI). LLM:', llmUrl || '(none)');
  return { sqlite3, db };
}
