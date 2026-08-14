/**
 * JS HARNESS — wa-sqlite JSPI bridge.
 *
 * Zero agentic logic. Boots wa-sqlite JSPI, registers UDFs, executes schema.
 * The ReAct loop lives entirely in SQL triggers.
 *
 * Session-aware: triggers are scoped per-session via `NEW.session_id`.
 * Token tracking: ask_llm returns prompt_tokens + completion_tokens.
 */

import 'prompt-api-polyfill';
import { LanguageModel } from 'prompt-api-polyfill';
import ModuleFactory from '../vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs';
import { Factory } from '../vendor/wa-sqlite-jspi/sqlite-api.js';
import { SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_UTF8, SQLITE_ROW } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
import { IDBBatchAtomicVFS } from '../vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js';
import { MemoryVFS } from '../vendor/wa-sqlite-jspi/MemoryVFS.js';
import { SCHEMA_SQL } from './schema.js';

export const AGENT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'Response text to the user' },
    tool_calls: {
      type: 'array',
      description: 'Tools to execute, or null/empty if answering directly',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: ['execute_sql', 'search_web', 'fetch_url'] },
          arguments: { type: 'object' }
        },
        required: ['name', 'arguments']
      }
    }
  },
  required: ['content']
};

export function setupPromptApiBackend(config = {}) {
  const {
    provider = 'openai',
    url = '',
    model = '',
    apiKey = ''
  } = config;

  // Clean previous configs on window
  delete window.OPENAI_CONFIG;
  delete window.GEMINI_CONFIG;
  delete window.FIREBASE_CONFIG;
  delete window.TRANSFORMERS_CONFIG;
  delete window.WEBLLM_CONFIG;

  if (provider === 'gemini') {
    window.GEMINI_CONFIG = {
      apiKey: apiKey || '',
      modelName: model || 'gemini-2.5-flash',
    };
  } else {
    // 'openai' / custom compatible (Ollama, LM Studio, OpenRouter, OpenAI)
    window.OPENAI_CONFIG = {
      baseURL: url || 'http://localhost:11434/v1',
      modelName: model || 'llama3.2',
      apiKey: apiKey || 'dummy',
    };
  }
}

export function buildSystemPrompt(tools = [], basePrompt = '') {
  let prompt = basePrompt || (
    'You are an autonomous SQL-driven data analyst agent. You have access to a SQLite database and external tools.\n' +
    'Always write correct, safe, read-only SQL. Think step by step.\n' +
    'When you need to query the database, search the web, or fetch a web page, invoke the corresponding tool via tool_calls.\n' +
    'When you have the final answer, provide the response in the content field and set tool_calls to null or empty.'
  );

  if (tools && tools.length > 0) {
    prompt += '\n\n# AVAILABLE TOOLS:';
    for (const t of tools) {
      const fn = t.function || t;
      prompt += `\n\n- Tool Name: ${fn.name}\n  Description: ${fn.description || ''}\n  Parameters: ${JSON.stringify(fn.parameters || {})}`;
    }
    prompt += '\n\nTo invoke a tool, return a tool_calls array with { "name": "<tool_name>", "arguments": { ... } }.\n' +
              'If answering directly without tools, return an empty array or null for tool_calls.';
  }

  return prompt;
}

export function formatConversation(messages = []) {
  const nonSystem = messages.filter(m => m.role !== 'system');
  if (nonSystem.length === 0) return 'Hello.';

  return nonSystem.map(m => {
    if (m.role === 'user') {
      return `User: ${m.content || ''}`;
    } else if (m.role === 'assistant') {
      let text = `Assistant: ${m.content || ''}`;
      if (m.tool_calls) {
        const callsStr = typeof m.tool_calls === 'string' ? m.tool_calls : JSON.stringify(m.tool_calls);
        text += `\n[Tool Executed]: ${callsStr}`;
      }
      return text;
    } else if (m.role === 'tool') {
      return `[Tool Output (id: ${m.tool_call_id || 'result'})]:\n${m.content || ''}`;
    }
    return `${m.role}: ${m.content || ''}`;
  }).join('\n\n') + '\n\nAssistant:';
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

  // Setup Prompt API backend configuration
  setupPromptApiBackend({
    provider: llmProvider,
    url: llmUrl,
    model: llmModel,
    apiKey: llmApiKey,
  });

  // 5. Register async UDF: ask_llm (JSPI suspends WASM during Prompt API inference)
  //    Uses prompt-api-polyfill's LanguageModel with responseConstraint structured output.
  await sqlite3.create_function(
    db, 'ask_llm', 2, SQLITE_UTF8, null,
    async (context, args) => {
      let session = null;
      try {
        const contextJson = sqlite3.value_text(args[0]);
        const toolsJson = sqlite3.value_text(args[1]);
        const messages = JSON.parse(contextJson);
        const tools = JSON.parse(toolsJson);

        // 1. Build system prompt and conversation history
        const systemMessage = messages.find(m => m.role === 'system');
        const systemPrompt = buildSystemPrompt(tools, systemMessage?.content);
        const formattedHistory = formatConversation(messages);

        // Ensure backend configuration is set
        if (!window.OPENAI_CONFIG && !window.GEMINI_CONFIG) {
          setupPromptApiBackend({
            provider: llmProvider,
            url: llmUrl,
            model: llmModel,
            apiKey: llmApiKey,
          });
        }

        const LM = window.LanguageModel || LanguageModel;
        if (!LM) {
          throw new Error('Prompt API LanguageModel is not available');
        }

        // 2. Create LanguageModel session with system prompt
        session = await LM.create({
          systemPrompt,
          initialPrompts: [
            { role: 'system', content: systemPrompt }
          ]
        });

        // 3. Call session.prompt with responseConstraint for structured output
        const rawResult = await session.prompt(formattedHistory, {
          responseConstraint: AGENT_RESPONSE_SCHEMA,
        });

        // 4. Parse structured JSON result
        let parsed;
        if (typeof rawResult === 'object' && rawResult !== null) {
          parsed = rawResult;
        } else {
          try {
            parsed = JSON.parse(rawResult);
          } catch {
            const cleaned = String(rawResult)
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/\s*```$/, '')
              .trim();
            parsed = JSON.parse(cleaned);
          }
        }

        // 5. Normalize tool_calls format for SQL triggers
        let toolCalls = null;
        if (parsed.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
          toolCalls = parsed.tool_calls.map((tc, idx) => {
            const fnName = tc.name || tc.function?.name || '';
            let fnArgs = tc.arguments || tc.function?.arguments || {};
            if (typeof fnArgs === 'string') {
              try { fnArgs = JSON.parse(fnArgs); } catch {}
            }
            return {
              id: tc.id || `call_${Date.now()}_${idx}`,
              type: 'function',
              name: fnName,
              function: {
                name: fnName,
                arguments: fnArgs,
              },
              arguments: fnArgs,
            };
          });
        }

        // 6. Token tracking
        let promptTokens = session.contextUsage || 0;
        if (!promptTokens) {
          const totalPromptChars = (systemPrompt.length + formattedHistory.length);
          promptTokens = Math.ceil(totalPromptChars / 4);
        }
        const completionTokens = Math.ceil(JSON.stringify(parsed).length / 4);

        // 7. Return JSON string expected by SQL triggers
        sqlite3.result_text(context, JSON.stringify({
          content: parsed.content || '',
          tool_calls: toolCalls,
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
      } finally {
        if (session && typeof session.destroy === 'function') {
          try { session.destroy(); } catch {}
        }
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

  // 8. Initialize schema (tables + triggers + sample data)
  await sqlite3.exec(db, SCHEMA_SQL);

  // 9. Schema migration: detect old agent_memory table and migrate into new schema
  try {
    let agentMemoryCount = 0;
    for await (const stmt of sqlite3.statements(db, `SELECT COUNT(*) FROM agent_memory`)) {
      if (await sqlite3.step(stmt) === SQLITE_ROW) {
        agentMemoryCount = sqlite3.column_int(stmt, 0);
      }
    }

    if (agentMemoryCount > 0) {
      console.warn(`[harness] Legacy agent_memory table detected (${agentMemoryCount} rows) — migrating`);
      // Drop old triggers (they reference agent_memory)
      await sqlite3.exec(db, 'DROP TRIGGER IF EXISTS agent_think;');
      await sqlite3.exec(db, 'DROP TRIGGER IF EXISTS execute_tool;');
      // Migrate rows into messages table (already created by SCHEMA_SQL)
      await sqlite3.exec(db, `
        INSERT OR IGNORE INTO messages (id, session_id, role, content, tool_calls, tool_call_id, created_at)
        SELECT id, 'default', CASE WHEN role='tool_result' THEN 'tool' ELSE role END, content, tool_calls, tool_call_id, created_at
        FROM agent_memory;
      `);
      await sqlite3.exec(db, 'DROP TABLE IF EXISTS agent_memory;');
      console.log('[harness] Migration complete');
    }
  } catch (e) {
    if (e.message?.includes('agent_memory')) {
      console.log('[harness] No legacy agent_memory table, skipping migration');
    } else {
      console.warn('[harness] Migration check error (non-fatal):', e.message);
    }
  }

  console.log('[harness] Agent booted (wa-sqlite JSPI). LLM:', llmUrl || '(none)');
  return { sqlite3, db };
}
