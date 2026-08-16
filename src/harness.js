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
import { SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_UTF8, SQLITE_ROW, SQLITE_INSERT, SQLITE_DELETE, SQLITE_UPDATE } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
import { IDBBatchAtomicVFS } from '../vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js';
import { MemoryVFS } from '../vendor/wa-sqlite-jspi/MemoryVFS.js';
import { SCHEMA_SQL, migrateTurnTables, migrateMessagesTable, migrateDashboardCardsTable, queryAll, isProtectedTable, isInternalTable, logDDL, sweepCaptureTriggers, extractTargetTables } from './schema.js';
import { runCompaction, queryActiveContextJson } from './compaction.js';
import { materializeToolResult } from './materialize.js';

/**
 * Live Event Stream for real-time UI streaming (tokens, tool execution, ReAct steps).
 */
export class AgentEventStream {
  constructor() {
    this._controllers = new Set();
  }

  /**
   * Get a new ReadableStream connected to this event stream.
   * @returns {ReadableStream}
   */
  getStream() {
    let activeController = null;
    return new ReadableStream({
      start: (controller) => {
        activeController = controller;
        this._controllers.add(controller);
      },
      cancel: () => {
        if (activeController) {
          this._controllers.delete(activeController);
        }
      },
    });
  }

  /**
   * Emit a structured event to all active stream readers.
   * @param {string} type - Event type ('thinking', 'token', 'tool_call', 'tool_result', 'react_step', 'data_change', 'done', 'error')
   * @param {object} [data] - Event payload
   */
  emit(type, data = {}) {
    const event = { type, timestamp: Date.now(), ...data };
    for (const controller of this._controllers) {
      try {
        controller.enqueue(event);
      } catch {
        this._controllers.delete(controller);
      }
    }
  }

  /**
   * Close all active controllers.
   */
  close() {
    for (const controller of this._controllers) {
      try { controller.close(); } catch {}
    }
    this._controllers.clear();
  }
}

// Global agent event stream instance
export const agentEventStream = new AgentEventStream();

/**
 * Export getEventStream for main.js to consume.
 * @returns {ReadableStream}
 */
export function getEventStream() {
  return agentEventStream.getStream();
}

// ── T3: Turn Stop (graceful) ─────────────────────────────────────────
// A shared AbortController for the in-flight turn. The turn wrapper (main.js)
// calls beginTurn() before the user INSERT and endTurn() after. requestStop()
// (the Stop button) sets stopRequested and aborts any in-flight fetch.
//
// ask_llm checks stopRequested at its start and on abort → returns a stop
// sentinel (tool_calls: null) so the cascade ends cleanly and completed work
// is kept. Tool UDFs use the same signal so their fetches abort promptly; the
// cascade then reaches the next ask_llm, which returns the sentinel.
let stopRequested = false;
let currentAbort = null;

export function beginTurn() {
  stopRequested = false;
  currentAbort = new AbortController();
  return currentAbort;
}

export function requestStop() {
  stopRequested = true;
  if (currentAbort) {
    try { currentAbort.abort(); } catch { /* already aborted */ }
  }
}

export function endTurn() {
  stopRequested = false;
  currentAbort = null;
}

export function isStopRequested() {
  return stopRequested;
}

/** The shared in-flight signal (undefined when no turn is active). */
function turnSignal() {
  return currentAbort ? currentAbort.signal : undefined;
}

/** Combine the turn-abort signal with an optional timeout (for tool UDFs). */
function turnSignalWith(timeoutMs) {
  const signals = [];
  if (currentAbort) signals.push(currentAbort.signal);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  // AbortSignal is a constructor (typeof === 'function'), not an object — guard
  // only for its existence so `AbortSignal.any` is actually used (otherwise tool
  // fetches would silently drop the timeout signal).
  return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function')
    ? AbortSignal.any(signals)
    : signals[0];
}

// ── T2: Reactive compaction — context-length 400 detection ───────────
// A provider context-length overflow surfaces as an HTTP 400 whose body
// mentions the limit. We detect it so ask_llm can compact + retry once.
export class ContextLengthError extends Error {
  constructor(status, text) {
    super(`context length exceeded (HTTP ${status}): ${text}`);
    this.name = 'ContextLengthError';
    this.status = status;
    this.text = text;
  }
}

export function isContextLengthError(status, text) {
  if (status !== 400) return false;
  return /context|too many tokens|prompt is too long|exceeds the (context|token|maximum)|token limit|maximum context|window is too small|longer than the model/i.test(text || '');
}

/**
 * Resolve provider endpoint URL.
 */
function resolveEndpointUrl(url, provider) {
  if (provider === 'gemini') {
    return url || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  }
  if (!url) return '';
  const cleanUrl = url.trim().replace(/\/+$/, '');
  if (cleanUrl.endsWith('/v1')) {
    return `${cleanUrl}/chat/completions`;
  }
  return cleanUrl;
}

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
export function formatMessages(messages = [], provider = 'openai') {
  const isGemini = provider === 'gemini';
  return messages.map(m => {
    if (isGemini) {
      if (m.role === 'assistant' && m.tool_calls) {
        const parsedCalls = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls;
        const body = {
          content: m.content || '',
          tool_calls: parsedCalls,
        };
        return { role: 'assistant', content: JSON.stringify(body) };
      }
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: `[Tool Result for ${m.tool_call_id || 'tool'}]:\n${m.content || ''}`,
        };
      }
      return { role: m.role, content: m.content || '' };
    }

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

  const endpointUrl = resolveEndpointUrl(llmUrl, llmProvider);
  if (!endpointUrl && llmProvider !== 'gemini') {
    console.warn('[harness] No LLM URL configured.');
  }

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

  // 4b. Register update_hook on db to emit 'react_step' events on message INSERTs
  // and 'data_change' events on DATA-table row changes (T11 reactivity
  // groundwork). The callback runs synchronously inside sqlite3.step — it must
  // do NO database work (single-threaded connection; the cascade may be
  // suspended mid-transaction). It only enqueues a small event; consumers
  // (grid-ui) accumulate changed tables and re-run affected cards at a
  // committed point (turn/scratchpad/ingest end), never mid-savepoint.
  // Internal tables (messages, session_context, dashboard_cards, …) are
  // excluded — they are agent/UI state, not data.
  sqlite3.update_hook(db, (iUpdateType, dbNameStr, tblName, rowid) => {
    if (tblName === 'messages' && iUpdateType === SQLITE_INSERT) {
      agentEventStream.emit('react_step', {
        table: tblName,
        action: 'INSERT',
        rowid: typeof rowid === 'bigint' ? Number(rowid) : rowid,
        dbName: dbNameStr,
      });
    }
    if (!isInternalTable(tblName)) {
      agentEventStream.emit('data_change', {
        table: tblName,
        op: iUpdateType === SQLITE_INSERT ? 'INSERT'
          : iUpdateType === SQLITE_DELETE ? 'DELETE' : 'UPDATE',
      });
    }
  });

  // 5a. T2: one LLM call (streaming + non-streaming fallback). Returns
  // { content, toolCalls, promptTokens, completionTokens, stopped }. Throws
  // ContextLengthError on a provider context-length 400 so the caller (ask_llm)
  // can compact + retry once. (Extracted from the UDF so the retry can re-invoke
  // it with a rebuilt context.)
  async function performLLMCall(apiMessages, tools) {
    let content = '';
    let toolCalls = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let streamSucceeded = false;

    const targetUrl = endpointUrl || resolveEndpointUrl(llmUrl, llmProvider);
    const targetApiKey = llmApiKey;
    const isGemini = llmProvider === 'gemini' || /generativelanguage\.googleapis\.com/i.test(targetUrl);
    const toolsPayload = (tools.length && !isGemini) ? tools.map(t => {
      const schema = typeof t === 'string' ? JSON.parse(t) : t;
      return schema;
    }) : undefined;

    // Try streaming via SSE first
    try {
      const streamResp = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(targetApiKey ? { Authorization: `Bearer ${targetApiKey}` } : {}),
        },
        signal: turnSignal(),
        body: JSON.stringify({
          model: llmModel,
          messages: apiMessages,
          ...(toolsPayload ? { tools: toolsPayload } : {}),
          ...(isGemini ? { response_format: { type: 'json_object' } } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      if (!streamResp.ok) {
        const errText = await streamResp.text().catch(() => '');
        if (isContextLengthError(streamResp.status, errText)) {
          throw new ContextLengthError(streamResp.status, errText);
        }
        // Non-context 4xx/5xx: fall through to the non-streaming fallback.
      } else if (streamResp.body) {
        const contentType = streamResp.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream') || !contentType.includes('application/json')) {
          // Process SSE stream chunks
          const reader = streamResp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const toolCallsMap = new Map();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue; // skip keep-alive comments
              if (trimmed === 'data: [DONE]') continue;
              if (trimmed.startsWith('data: ')) {
                try {
                  const data = JSON.parse(trimmed.slice(6));
                  const choice = data.choices?.[0];
                  if (choice?.delta?.content) {
                    const token = choice.delta.content;
                    content += token;
                    agentEventStream.emit('token', {
                      token,
                      accumulated: content,
                      role: 'assistant',
                    });
                  }
                  if (choice?.delta?.tool_calls) {
                    for (const tc of choice.delta.tool_calls) {
                      const idx = tc.index ?? 0;
                      if (!toolCallsMap.has(idx)) {
                        toolCallsMap.set(idx, {
                          id: tc.id || `call_${Date.now()}_${idx}`,
                          type: 'function',
                          function: {
                            name: tc.function?.name || '',
                            arguments: tc.function?.arguments || '',
                          },
                        });
                      } else {
                        const existing = toolCallsMap.get(idx);
                        if (tc.id) existing.id = tc.id;
                        if (tc.function?.name) existing.function.name += tc.function.name;
                        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                      }
                    }
                  }
                  if (data.usage) {
                    promptTokens = data.usage.prompt_tokens || promptTokens;
                    completionTokens = data.usage.completion_tokens || completionTokens;
                  }
                } catch {
                  // Skip invalid SSE JSON chunk
                }
              }
            }
          }

          if (toolCallsMap.size > 0) {
            toolCalls = Array.from(toolCallsMap.values());
          }
          streamSucceeded = true;
        } else {
          // Endpoint returned normal JSON despite stream: true
          const data = await streamResp.json();
          const msg = data.choices?.[0]?.message || data.message || {};
          content = msg.content || '';
          toolCalls = msg.tool_calls || null;
          if (data.usage) {
            promptTokens = data.usage.prompt_tokens || 0;
            completionTokens = data.usage.completion_tokens || 0;
          }
          if (content) {
            agentEventStream.emit('token', {
              token: content,
              accumulated: content,
              role: 'assistant',
            });
          }
          streamSucceeded = true;
        }
      }
    } catch (streamErr) {
      if (streamErr instanceof ContextLengthError) throw streamErr; // T2: propagate
      // T3: if the stop aborted the streaming fetch, end the cascade now —
      // do NOT fall back to a second (also-aborted) fetch.
      if (stopRequested || (streamErr && (streamErr.name === 'AbortError' || streamErr.name === 'TimeoutError'))) {
        agentEventStream.emit('done', { stopped: true });
        return { content: '⏹ Turn stopped by user.', toolCalls: null, promptTokens: 0, completionTokens: 0, stopped: true };
      }
      console.warn('[ask_llm] Streaming attempt failed, falling back to non-streaming:', streamErr);
    }

    // Non-streaming fallback if streaming did not succeed
    if (!streamSucceeded) {
      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(targetApiKey ? { Authorization: `Bearer ${targetApiKey}` } : {}),
        },
        signal: turnSignal(),
        body: JSON.stringify({
          model: llmModel,
          messages: apiMessages,
          ...(toolsPayload ? { tools: toolsPayload } : {}),
          ...(isGemini ? { response_format: { type: 'json_object' } } : {}),
          stream: false,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        if (isContextLengthError(resp.status, errText)) {
          throw new ContextLengthError(resp.status, errText);
        }
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }
      const data = await resp.json();
      const msg = data.choices?.[0]?.message || data.message || {};

      // Extract token usage
      const usage = data.usage || {};
      promptTokens = usage.prompt_tokens || 0;
      completionTokens = usage.completion_tokens || 0;

      content = msg.content || '';
      toolCalls = msg.tool_calls || null;

      if (content) {
        agentEventStream.emit('token', {
          token: content,
          accumulated: content,
          role: 'assistant',
        });
      }
    }

    return { content, toolCalls, promptTokens, completionTokens, stopped: false };
  }

  // 5. Register async UDF: ask_llm (JSPI suspends WASM during fetch & streaming)
  await sqlite3.create_function(
    db, 'ask_llm', 2, SQLITE_UTF8, null,
    async (context, args) => {
      // T3: graceful stop — if the user hit Stop before this LLM call, end the
      // cascade cleanly (no tool_calls) and keep completed work.
      if (stopRequested) {
        agentEventStream.emit('done', { stopped: true });
        sqlite3.result_text(context, JSON.stringify({
          content: '⏹ Turn stopped by user.',
          tool_calls: null,
          prompt_tokens: 0,
          completion_tokens: 0,
        }));
        return;
      }
      try {
        const contextJson = sqlite3.value_text(args[0]);
        const toolsJson = sqlite3.value_text(args[1]);
        let messages = JSON.parse(contextJson);
        const tools = JSON.parse(toolsJson);

        // Build system prompt with tool definitions
        let systemMsg = messages.find(m => m.role === 'system');
        let systemPrompt = buildSystemPrompt(tools, systemMsg?.content);

        // Format messages for API
        let apiMessages = [
          { role: 'system', content: systemPrompt },
          ...formatMessages(messages.filter(m => m.role !== 'system'), llmProvider)
        ];

        // Emit 'thinking' event
        agentEventStream.emit('thinking', {
          role: 'assistant',
          messageCount: apiMessages.length,
          model: llmModel,
        });

        // T2: reactive compaction — on a provider context-length 400, compact,
        // rebuild the context from the view, and retry the fetch ONCE (the failed
        // call inserted nothing, so the view is unchanged by the failure).
        let result;
        let retried = false;
        while (true) {
          try {
            result = await performLLMCall(apiMessages, tools);
            break;
          } catch (e) {
            if (e instanceof ContextLengthError && !retried) {
              const sessRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'active_session_id'`);
              const activeSessionId = sessRows.length ? sessRows[0][0] : 'default';
              const llmCfg = { model: llmModel, endpointUrl: endpointUrl || resolveEndpointUrl(llmUrl, llmProvider), apiKey: llmApiKey };
              const comp = await runCompaction(sqlite3, db, activeSessionId, llmCfg, { reason: 'reactive', signal: turnSignal() });
              if (comp) {
                // Rebuild the context from the view (the watermark advanced).
                messages = JSON.parse(await queryActiveContextJson(sqlite3, db));
                systemMsg = messages.find(m => m.role === 'system');
                systemPrompt = buildSystemPrompt(tools, systemMsg?.content);
                apiMessages = [
                  { role: 'system', content: systemPrompt },
                  ...formatMessages(messages.filter(m => m.role !== 'system'), llmProvider)
                ];
                agentEventStream.emit('thinking', {
                  role: 'assistant',
                  messageCount: apiMessages.length,
                  model: llmModel,
                  compacted: true,
                });
                retried = true;
                continue; // retry the fetch with the compacted context
              }
            }
            throw e; // non-context error, or context error with no compaction possible
          }
        }

        // T3: graceful stop — the in-flight fetch was aborted.
        if (result.stopped) {
          sqlite3.result_text(context, JSON.stringify({
            content: result.content,
            tool_calls: null,
            prompt_tokens: 0,
            completion_tokens: 0,
          }));
          return;
        }

        let { content, toolCalls, promptTokens, completionTokens } = result;

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
          if (parsed && typeof parsed === 'object') {
            content = parsed.content !== undefined ? parsed.content : content;
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

        // Emit 'tool_call' events if tool calls are present
        if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            let parsedArgs = tc.function?.arguments;
            if (typeof parsedArgs === 'string') {
              try { parsedArgs = JSON.parse(parsedArgs); } catch {}
            }
            agentEventStream.emit('tool_call', {
              id: tc.id,
              name: tc.function?.name || '',
              arguments: parsedArgs,
            });
          }
        }

        // Fallback token estimation if usage was 0
        if (!promptTokens && !completionTokens && content) {
          completionTokens = Math.max(1, Math.ceil(content.length / 4));
        }

        sqlite3.result_text(context, JSON.stringify({
          content: content || '',
          tool_calls: toolCalls || null,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        }));
      } catch (e) {
        // T3: graceful stop — the abort (or a stop flag set mid-flight) ends the
        // cascade cleanly; completed work is kept.
        if (stopRequested || (e && (e.name === 'AbortError' || e.name === 'TimeoutError'))) {
          agentEventStream.emit('done', { stopped: true });
          sqlite3.result_text(context, JSON.stringify({
            content: '⏹ Turn stopped by user.',
            tool_calls: null,
            prompt_tokens: 0,
            completion_tokens: 0,
          }));
          return;
        }
        // T3: hard transport error — RE-THROW so the turn wrapper rolls back the
        // whole turn (savepoint) and re-inserts the user message with an error
        // note. (Previously this swallowed the error into a "⚠ SYSTEM ERROR"
        // row, which poisoned the next turn's context.)
        console.error('[ask_llm] transport error, re-throwing for turn rollback:', e);
        agentEventStream.emit('error', { error: e.message });
        throw e;
      }
    }
  );

  // 6. Register async UDF: run_dynamic_sql (JSPI suspends WASM during query execution)
  await sqlite3.create_function(
    db, 'run_dynamic_sql', 1, SQLITE_UTF8, null,
    async (context, args) => {
      const sql = sqlite3.value_text(args[0]);
      agentEventStream.emit('tool_call', {
        name: 'execute_sql',
        arguments: { query: sql },
      });
      try {
        if (!sql) {
          const res = { error: 'Empty query' };
          agentEventStream.emit('tool_result', { tool: 'execute_sql', query: sql, error: res.error, result: res });
          sqlite3.result_text(context, JSON.stringify(res));
          return;
        }
        const t = sql.trim().toUpperCase();
        const firstWord = (t.split(/\s+/)[0] || '').replace(/[^A-Z]/g, '');
        const isReadOnly = firstWord === 'SELECT' || firstWord === 'WITH' || firstWord === 'EXPLAIN' || firstWord === 'PRAGMA';
        const isDDL = firstWord === 'CREATE' || firstWord === 'DROP' || firstWord === 'ALTER';

        if (!isReadOnly) {
          // T21: Protected-tables boundary check on write targets
          const targets = extractTargetTables(sql);
          for (const target of targets) {
            if (isProtectedTable(target.name)) {
              if (target.operation === 'ddl') {
                const res = {
                  error: `Operation rejected: Cannot execute DDL (${target.verb}) on protected table '${target.name}'.`,
                };
                agentEventStream.emit('tool_result', { tool: 'execute_sql', query: sql, error: res.error, result: res });
                sqlite3.result_text(context, JSON.stringify(res));
                return;
              }
              if (target.operation === 'dml') {
                // Option A: Only allow system_config modifications
                if (target.name.toLowerCase() !== 'system_config') {
                  const res = {
                    error: `Operation rejected: Cannot modify protected system table '${target.name}'.`,
                  };
                  agentEventStream.emit('tool_result', { tool: 'execute_sql', query: sql, error: res.error, result: res });
                  sqlite3.result_text(context, JSON.stringify(res));
                  return;
                }
              }
            }
          }

          // Read allow_dml from system_config (default ON '1')
          let allowDml = true;
          for await (const cfgStmt of sqlite3.statements(db, `SELECT value FROM system_config WHERE key = 'allow_dml'`)) {
            if (await sqlite3.step(cfgStmt) === SQLITE_ROW) allowDml = sqlite3.row(cfgStmt)[0] !== '0';
          }

          if (!allowDml) {
            const res = {
              error: 'Database write operations are disabled in system_config (allow_dml = 0).',
            };
            agentEventStream.emit('tool_result', { tool: 'execute_sql', query: sql, error: res.error, result: res });
            sqlite3.result_text(context, JSON.stringify(res));
            return;
          }

          // Permission popup for the user
          const userApproved = (typeof window !== 'undefined' && typeof window.confirm === 'function')
            ? window.confirm(`Agent requests permission to execute write SQL:\n\n${sql.trim()}\n\nAllow execution?`)
            : true;

          if (!userApproved) {
            const res = { error: 'Permission denied: user rejected the database write operation.' };
            agentEventStream.emit('tool_result', { tool: 'execute_sql', query: sql, error: res.error, result: res });
            sqlite3.result_text(context, JSON.stringify(res));
            return;
          }

          // If DDL, log to turn_ddl_log for rewind undo
          if (isDDL) {
            const sessRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'active_session_id'`);
            const sessId = sessRows.length ? sessRows[0][0] : 'default';
            const turnRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'current_turn_id'`);
            const turnId = turnRows.length && turnRows[0][0] !== '' ? parseInt(turnRows[0][0], 10) : 0;

            await logDDL(sqlite3, db, {
              turnId,
              sessionId: sessId,
              tableName: null,
              ddlSql: sql,
              preImage: null,
            });
          }
        }

        const rows = [];
        let cols = [];
        for await (const stmt of sqlite3.statements(db, sql)) {
          cols = sqlite3.column_names(stmt);
          while (await sqlite3.step(stmt) === SQLITE_ROW) {
            rows.push(sqlite3.row(stmt));
          }
        }

        if (isDDL) {
          await sweepCaptureTriggers(sqlite3, db);
        }

        let result;
        if (cols.length > 0 || rows.length > 0) {
          result = [{
            columns: cols,
            values: rows,
          }];
        } else {
          result = [{
            columns: ['status', 'changes'],
            values: [['OK', 1]],
          }];
        }
        agentEventStream.emit('tool_result', {
          tool: 'execute_sql',
          query: sql,
          result,
        });
        sqlite3.result_text(context, JSON.stringify(result));
      } catch (e) {
        const res = { error: e.message };
        agentEventStream.emit('tool_result', { tool: 'execute_sql', query: sql, error: e.message, result: res });
        sqlite3.result_text(context, JSON.stringify(res));
      }
    }
  );

  // 7. Register async UDF: search_web (web search via DuckDuckGo)
  await sqlite3.create_function(
    db, 'search_web', 1, SQLITE_UTF8, null,
    async (context, args) => {
      const query = sqlite3.value_text(args[0]);
      agentEventStream.emit('tool_call', {
        name: 'search_web',
        arguments: { query },
      });
      try {
        if (!query) {
          const res = { error: 'Empty search query' };
          agentEventStream.emit('tool_result', { tool: 'search_web', query, error: res.error, result: res });
          sqlite3.result_text(context, JSON.stringify(res));
          return;
        }
        const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        const resp = await fetch(searchUrl, { headers: { 'Accept': 'application/json' }, signal: turnSignalWith(15000) });
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
        const payload = { query, results: results.slice(0, 10) };
        agentEventStream.emit('tool_result', {
          tool: 'search_web',
          query,
          result: payload,
        });
        sqlite3.result_text(context, JSON.stringify(payload));
      } catch (e) {
        console.error('[search_web]', e);
        const res = { error: e.message };
        agentEventStream.emit('tool_result', { tool: 'search_web', query, error: e.message, result: res });
        sqlite3.result_text(context, JSON.stringify(res));
      }
    }
  );

  // 8. Register async UDF: fetch_url (with SSRF protection)
  await sqlite3.create_function(
    db, 'fetch_url', 1, SQLITE_UTF8, null,
    async (context, args) => {
      const url = sqlite3.value_text(args[0]);
      agentEventStream.emit('tool_call', {
        name: 'fetch_url',
        arguments: { url },
      });
      try {
        if (!url) {
          const res = { error: 'Empty URL' };
          agentEventStream.emit('tool_result', { tool: 'fetch_url', url, error: res.error, result: res });
          sqlite3.result_text(context, JSON.stringify(res));
          return;
        }
        const blocked = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^::1$/, /^fc00:/i, /^fe80:/i];
        let parsedUrl;
        try { parsedUrl = new URL(url); } catch {
          const res = { error: 'Invalid URL' };
          agentEventStream.emit('tool_result', { tool: 'fetch_url', url, error: res.error, result: res });
          sqlite3.result_text(context, JSON.stringify(res));
          return;
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          const res = { error: 'Only HTTP/HTTPS allowed' };
          agentEventStream.emit('tool_result', { tool: 'fetch_url', url, error: res.error, result: res });
          sqlite3.result_text(context, JSON.stringify(res));
          return;
        }
        for (const p of blocked) {
          if (p.test(parsedUrl.hostname)) {
            const res = { error: `Blocked: ${parsedUrl.hostname}` };
            agentEventStream.emit('tool_result', { tool: 'fetch_url', url, error: res.error, result: res });
            sqlite3.result_text(context, JSON.stringify(res));
            return;
          }
        }

        let html = '';
        let respStatus = 200;

        // 1. Try local dev proxy endpoint first
        try {
          const proxyUrl = `/api/fetch-proxy?url=${encodeURIComponent(url)}`;
          const proxyResp = await fetch(proxyUrl, { signal: turnSignalWith(12000) });
          if (proxyResp.ok) {
            respStatus = proxyResp.status;
            html = await proxyResp.text();
          }
        } catch { /* proceed to direct fetch fallback */ }

        // 2. If dev proxy did not respond, try direct fetch
        if (!html) {
          try {
            const resp = await fetch(url, { signal: turnSignalWith(10000) });
            if (resp.ok) {
              respStatus = resp.status;
              html = await resp.text();
            }
          } catch { /* proceed to public CORS proxy fallback */ }
        }

        // 3. Fallback to public CORS proxies if direct browser fetch was blocked by CORS
        if (!html) {
          const corsProxies = [
            `https://corsproxy.io/?${encodeURIComponent(url)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
          ];
          for (const cp of corsProxies) {
            try {
              const resp = await fetch(cp, { signal: turnSignalWith(10000) });
              if (resp.ok) {
                respStatus = resp.status;
                html = await resp.text();
                if (html) break;
              }
            } catch { /* try next proxy */ }
          }
        }

        if (!html) throw new Error('Failed to fetch page (blocked by CORS or network error)');

        const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        const payload = { url, status: respStatus, title: html.match(/<title>(.*?)<\/title>/i)?.[1] || '(no title)', content: text, truncated: html.length > 8000 };
        agentEventStream.emit('tool_result', {
          tool: 'fetch_url',
          url,
          result: payload,
        });
        sqlite3.result_text(context, JSON.stringify(payload));
      } catch (e) {
        console.error('[fetch_url]', e);
        const res = { error: e.message };
        agentEventStream.emit('tool_result', { tool: 'fetch_url', url, error: e.message, result: res });
        sqlite3.result_text(context, JSON.stringify(res));
      }
    }
  );

  // 8b. Register async UDF: materialize (T13: tool-output materialization engine)
  await sqlite3.create_function(
    db, 'materialize', -1, SQLITE_UTF8, null,
    async (context, args) => {
      const tableName = args.length > 0 ? sqlite3.value_text(args[0]) : null;
      const toolCallId = args.length > 1 ? sqlite3.value_text(args[1]) : null;
      agentEventStream.emit('tool_call', {
        name: 'materialize',
        arguments: { table_name: tableName, tool_call_id: toolCallId || undefined },
      });
      try {
        const res = await materializeToolResult(sqlite3, db, {
          tableName,
          toolCallId: toolCallId || null,
        });
        agentEventStream.emit('tool_result', {
          tool: 'materialize',
          table: tableName,
          result: res,
          error: res.error,
        });
        sqlite3.result_text(context, JSON.stringify(res));
      } catch (e) {
        console.error('[materialize]', e);
        const res = { error: e.message };
        agentEventStream.emit('tool_result', {
          tool: 'materialize',
          table: tableName,
          error: e.message,
          result: res,
        });
        sqlite3.result_text(context, JSON.stringify(res));
      }
    }
  );

  // 9. T9 migration: add messages.in_context BEFORE SCHEMA_SQL — the T9
  // agent_think trigger references the column, and CREATE TRIGGER fails on a
  // missing column. (No-op on fresh brains: the table doesn't exist yet and
  // SCHEMA_SQL creates it with the column.)
  try {
    await migrateMessagesTable(sqlite3, db);
  } catch (e) {
    console.warn('[harness] migrateMessagesTable failed (non-fatal):', e.message);
  }

  // 9b. Initialize schema
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

  // 10b. Migration: drop the stale NOT NULL `seq` column from the T3 turn
  // tables (an early draft had it; the final schema orders by `id`).
  try {
    await migrateTurnTables(sqlite3, db);
  } catch (e) {
    console.warn('[harness] migrateTurnTables failed (non-fatal):', e.message);
  }

  // 10c. Migration: expand dashboard_cards table to infinite grid
  try {
    await migrateDashboardCardsTable(sqlite3, db);
  } catch (e) {
    console.warn('[harness] migrateDashboardCardsTable failed (non-fatal):', e.message);
  }

  console.log('[harness] Agent booted (wa-sqlite JSPI). LLM:', endpointUrl || '(none)');
  // `module` is the raw WASM module — exposed so cartridge.js can cwrap
  // exports the JS API wrapper lacks (sqlite3_serialize, sqlite3_deserialize,
  // sqlite3_backup_*).
  // `llm` is the resolved LLM config — exposed so compaction.js (T2) can make
  // its one-shot summary fetch to the same model/endpoint.
  return {
    sqlite3, db, eventStream: agentEventStream, module,
    llm: { model: llmModel, endpointUrl, apiKey: llmApiKey, provider: llmProvider },
  };
}
