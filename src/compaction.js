/**
 * COMPACTION (T2) — interval compaction via in-session watermark.
 *
 * The LLM's working context is the `v_active_context` view = [system, latest
 * rolling summary (synthetic `user` row), messages after the compaction
 * watermark]. When the context grows past 85% of the model's effective window,
 * we compact: summarize the old prefix into a rolling summary (tau's schema,
 * SQL-adapted) and advance the watermark to a pair-safe turn boundary, keeping
 * a full-fidelity tail of min(max(20k, 15%), 60%) tokens.
 *
 * `messages` is NEVER touched — compaction writes a row to `compactions`
 * (summaries only). The original rows stay immutable and fully traceable (walk
 * the watermarks in seq order to reconstruct provenance).
 *
 * Three triggers (all call runCompaction):
 *   - proactive: JS at turn start, BEFORE the user-row insert / turn savepoint
 *     (provider-anchored estimate over the threshold → compact first).
 *   - reactive:  inside ask_llm on a provider context-length 400 (compact +
 *     rebuild from the view + retry the fetch ONCE).
 *   - manual:    `/compact [instructions]` chat command (keep 0 — summarize the
 *     ENTIRE active context; optional instructions → "Additional focus: …").
 *
 * Rolling: seq=0 uses the initial prompt; seq>0 = an UPDATE prompt over the
 * `seq = current − 1` summary + only the newly-summarized rows (the tail after
 * the old watermark — rows below the old watermark are NOT re-read, the prior
 * summary already covers them, which keeps each compaction's input bounded).
 * The new summary SUBSUMES the prior one (a fresh full snapshot, not a diff).
 * The view reads only max(seq) — earlier rows stay as provenance.
 */

import { queryAll, execParams } from './schema.js';

// ── Knobs (tau-derived, code constants — NOT stored) ─────────────────
export const COMPACTION_THRESHOLD = 0.85; // compact at 85% of the window
export const TAIL_FLOOR = 20000;          // keep at least 20k tokens of tail
export const TAIL_FRACTION = 0.15;        // … or 15% of the window,
export const TAIL_CEILING = 0.60;         // … capped at 60% (small windows)
export const FALLBACK_WINDOW = 128000;    // tau's DEFAULT_CONTEXT_WINDOW_TOKENS

// Cloud model-name lookup: the raw cloud window is 1M — too big for a browser
// prefix. Map known cloud model families to a sane effective window (128k).
// Local models (llama, qwen, mistral, phi, …) are NOT here — they resolve via
// the user override or the fallback. Extension point for per-model tuning.
const CLOUD_MODEL_WINDOWS = [
  { pattern: /gemini/i, window: FALLBACK_WINDOW },
  { pattern: /gpt-4|gpt-5|o[1-9]-/i, window: FALLBACK_WINDOW },
  { pattern: /claude/i, window: FALLBACK_WINDOW },
];

/** Lookup a cloud model's effective window by name. Returns null if the model
 *  is not a known cloud model (local / unknown → user override or fallback). */
export function lookupCloudWindow(model) {
  if (!model) return null;
  for (const { pattern, window } of CLOUD_MODEL_WINDOWS) {
    if (pattern.test(model)) return window;
  }
  return null;
}

/**
 * Resolve the effective context window (tokens).
 * Priority: (1) user override (system_config.effective_context_window, written
 * by the settings field) → (2) cloud model-name lookup → (3) the stored
 * fallback (128000, seeded by the migration).
 *
 * A stored value that differs from the fallback sentinel is treated as an
 * explicit user override. (If the user explicitly sets the fallback value on a
 * cloud model, the lookup applies instead — numerically identical, so no
 * behavioral difference.)
 */
export function resolveContextWindow(storedRaw, model) {
  const stored = parseInt(storedRaw, 10);
  const hasStored = Number.isFinite(stored) && stored > 0;
  if (hasStored && stored !== FALLBACK_WINDOW) return stored; // (1) user override
  const cloud = lookupCloudWindow(model);                     // (2) cloud lookup
  if (cloud) return cloud;
  return hasStored ? stored : FALLBACK_WINDOW;                // (3) fallback
}

/** Retained full-fidelity tail budget: min(max(20k, 15% of window), 60% of window).
 *  The 60% ceiling keeps `summary + tail < 85%` at any window size (a bare
 *  20k floor would exceed the whole window for small local models → thrash). */
export function tailBudget(window) {
  return Math.min(
    Math.max(TAIL_FLOOR, Math.floor(window * TAIL_FRACTION)),
    Math.floor(window * TAIL_CEILING),
  );
}

/** The summary's own length cap (belt-and-suspenders). Derived from the 60%
 *  tail ceiling + 85% threshold: keeping the summary under 25% of the window
 *  guarantees `summary + tail < 85%` at any window size. */
export function summaryCap(window) {
  return Math.floor(window * 0.25);
}

/** Rough token estimate for one row's contribution (chars ÷ 4). */
function estTokens(content, toolCalls, toolCallId) {
  let chars = 0;
  if (content) chars += String(content).length;
  if (toolCalls) chars += String(toolCalls).length;
  if (toolCallId) chars += String(toolCallId).length;
  return Math.ceil(chars / 4);
}

/** Read a system_config value (null if absent). */
async function getConfigValue(sqlite3, db, key) {
  const rows = await queryAll(sqlite3, db, `SELECT value FROM system_config WHERE key = ?`, [key]);
  return rows.length ? rows[0][0] : null;
}

/**
 * Provider-anchored estimate of the current active-context size (tokens):
 * the latest assistant row's `prompt_tokens` (the provider's own count) +
 * chars÷4 over the visible rows added after it. Falls back to chars÷4 over the
 * whole view when there's no anchor (no real LLM call yet).
 */
export async function estimateActiveContextTokens(sqlite3, db, sessionId) {
  const anchorRows = await queryAll(sqlite3, db, `
    SELECT id, prompt_tokens FROM messages
    WHERE session_id = ? AND role = 'assistant' AND prompt_tokens > 0
    ORDER BY id DESC LIMIT 1
  `, [sessionId]);
  const anchor = anchorRows[0]; // [id, prompt_tokens] | undefined

  const ctx = await queryAll(sqlite3, db, `
    SELECT id, content, tool_calls, tool_call_id FROM v_active_context
    WHERE session_id = ? ORDER BY ctx_order ASC
  `, [sessionId]);

  let est = 0;
  if (anchor) {
    est = anchor[1]; // provider-anchored
    for (const [id, content, toolCalls, toolCallId] of ctx) {
      if (typeof id === 'number' && id > anchor[0]) {
        est += estTokens(content, toolCalls, toolCallId);
      }
    }
  } else {
    for (const [, content, toolCalls, toolCallId] of ctx) {
      est += estTokens(content, toolCalls, toolCallId);
    }
  }
  return est;
}

/**
 * Plan a compaction: find the pair-safe watermark.
 *
 * Watermark rule (pair-safe): walk back over in_context=1 rows from the tail
 * accumulating estimates until ≥ keepBudget; advance FORWARD to the next
 * in_context=1 `user` message (turn boundary — tool pairs never cross a user
 * message, so the cut is pair-safe by construction); watermark_id = MAX(id) <
 * firstRetainedId.
 *
 * @returns {Promise<{watermarkId, firstRetainedId, summarizedCount, keepBudget} | null>}
 *   null if nothing should be summarized (region too small, or no valid cut).
 */
async function planCompaction(sqlite3, db, sessionId, keepBudget) {
  const wmRows = await queryAll(sqlite3, db, `
    SELECT COALESCE(MAX(watermark_id), -1) FROM compactions WHERE session_id = ?
  `, [sessionId]);
  const currentWm = wmRows[0][0]; // -1 if no compaction yet

  // The visible region: in_context=1 rows after the current watermark, id order.
  const rows = await queryAll(sqlite3, db, `
    SELECT id, role, content, tool_calls, tool_call_id FROM messages
    WHERE session_id = ? AND COALESCE(in_context, 1) = 1 AND id > ?
    ORDER BY id ASC
  `, [sessionId, currentWm]);

  if (rows.length === 0) return null; // nothing visible to summarize

  // Manual compaction (keepBudget = 0): summarize the ENTIRE visible region.
  // The active context becomes [system, summary] — no orphaned tool pairs
  // (no tool messages remain). Pair-safe by construction.
  if (keepBudget <= 0) {
    const last = rows[rows.length - 1];
    return { watermarkId: last[0], firstRetainedId: null, summarizedCount: rows.length, keepBudget: 0 };
  }

  // Walk back from the tail accumulating estimates until ≥ keepBudget.
  let acc = 0;
  let cutIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    acc += estTokens(rows[i][2], rows[i][3], rows[i][4]);
    if (acc >= keepBudget) { cutIndex = i; break; }
  }
  if (cutIndex === -1) return null; // whole region < keepBudget → nothing worth compacting

  // Advance FORWARD to the next in_context=1 user message (turn boundary).
  let firstRetainedIndex = -1;
  if (rows[cutIndex][1] === 'user') {
    firstRetainedIndex = cutIndex;
  } else {
    for (let j = cutIndex + 1; j < rows.length; j++) {
      if (rows[j][1] === 'user') { firstRetainedIndex = j; break; }
    }
    // No user message forward (the cut is in the last turn): fall back to the
    // last user message at or before the cut point (the start of that turn).
    // The tail is pair-safe (starts at a user message) and ≥ keepBudget.
    if (firstRetainedIndex === -1) {
      for (let i = cutIndex; i >= 0; i--) {
        if (rows[i][1] === 'user') { firstRetainedIndex = i; break; }
      }
    }
  }
  if (firstRetainedIndex === -1) return null; // no user message at all (defensive)

  // tau: first_kept_index <= 0 → None (nothing before the first retained row).
  if (firstRetainedIndex === 0) return null;

  return {
    watermarkId: rows[firstRetainedIndex - 1][0],
    firstRetainedId: rows[firstRetainedIndex][0],
    summarizedCount: firstRetainedIndex,
    keepBudget,
  };
}

/**
 * Build the summary prompt (tau's structured-markdown schema, SQL-adapted).
 * seq=0 → initial prompt over the conversation; seq>0 → UPDATE prompt over the
 * previous summary + only the newly-summarized rows.
 */
function buildSummaryPrompt({ isUpdate, prevSummary, messages, instructions, cap }) {
  const headings = [
    '## Goal',
    '## Constraints & Preferences',
    '## Progress',
    '### Done',
    '### In Progress',
    '### Blocked',
    '## Key Decisions',
    '## Next Steps',
    '## Critical Context',
  ].join('\n');

  const rules = [
    `- Be concise but complete. Keep the whole summary under ${cap} tokens.`,
    '- Preserve exact table names, column names, SQL, and error messages verbatim.',
    '- Do not invent facts that are not present in the conversation.',
  ];
  if (instructions) rules.push(`- Additional focus: ${instructions}`);

  const formatted = messages.map(([role, content, toolCalls, toolCallId]) => {
    let line = `${role}: ${content || ''}`;
    if (role === 'assistant' && toolCalls) line += ` [tool_calls: ${toolCalls}]`;
    if (role === 'tool' && toolCallId) line += ` [tool_call_id: ${toolCallId}]`;
    return line;
  }).join('\n');

  if (isUpdate) {
    return (
      'You are updating a running summary of a conversation between a user and a SQL data-analyst agent. ' +
      'A previous summary covers the earlier part of the conversation; below are the NEW messages since that summary.\n\n' +
      'Produce an UPDATED summary that FULLY SUBSUMES the previous summary (it replaces it — it must stand alone, not be a diff). ' +
      'Use EXACTLY these section headings, in this order:\n\n' + headings + '\n\n' +
      'Rules:\n' + rules.join('\n') + '\n\n' +
      'Previous summary:\n<previous-summary>\n' + prevSummary + '\n</previous-summary>\n\n' +
      'New messages since the previous summary:\n' + formatted
    );
  }

  return (
    'You are summarizing a conversation between a user and a SQL data-analyst agent so the agent can continue from a compact summary instead of the full history.\n\n' +
    'Write a structured summary using EXACTLY these section headings, in this order:\n\n' + headings + '\n\n' +
    'Rules:\n' + rules.join('\n') + '\n\n' +
    'Conversation to summarize:\n' + formatted
  );
}

/**
 * One-shot LLM call for the summary: direct fetch to the same model/endpoint,
 * NO tools, outside the cascade (not the ask_llm UDF). Returns the summary text.
 */
async function fetchSummary(llmCfg, prompt, signal) {
  const resp = await fetch(llmCfg.endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(llmCfg.apiKey ? { Authorization: `Bearer ${llmCfg.apiKey}` } : {}),
    },
    signal,
    body: JSON.stringify({
      model: llmCfg.model,
      messages: [
        { role: 'system', content: 'You produce concise, structured conversation summaries. Respond with the summary text only — no code fences, no preamble.' },
        { role: 'user', content: prompt },
      ],
      stream: false,
    }),
  });
  if (!resp.ok) {
    throw new Error(`compaction LLM HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  // Strip markdown code fences if the model added them despite the instruction.
  return content.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/**
 * Run a compaction: plan the pair-safe watermark, fetch the rolling summary
 * from the LLM (one-shot, no tools), and insert the compaction row.
 *
 * @param {object} llmCfg - { model, endpointUrl, apiKey } (same as the harness)
 * @param {object} [opts]
 * @param {string} [opts.instructions] - manual: appended as "Additional focus: …"
 * @param {number} [opts.keepBudget] - undefined → tailBudget(window); 0 → summarize all (manual)
 * @param {AbortSignal} [opts.signal] - abort signal (the turn's controller)
 * @param {string} [opts.reason] - 'proactive' | 'reactive' | 'manual' (logging)
 * @returns {Promise<{seq, watermarkId, summary, summarizedCount} | null>}
 *   null if nothing should be summarized.
 */
export async function runCompaction(sqlite3, db, sessionId, llmCfg, opts = {}) {
  const { instructions = '', keepBudget, signal, reason = 'proactive' } = opts;

  const storedRaw = await getConfigValue(sqlite3, db, 'effective_context_window');
  const window = resolveContextWindow(storedRaw, llmCfg.model);
  const budget = keepBudget !== undefined ? keepBudget : tailBudget(window);

  const plan = await planCompaction(sqlite3, db, sessionId, budget);
  if (!plan) {
    console.log(`[compaction] ${reason}: nothing to summarize (session ${sessionId})`);
    return null;
  }

  // The newly-summarized rows: id in (currentWatermark, plan.watermarkId].
  const wmRows = await queryAll(sqlite3, db, `
    SELECT COALESCE(MAX(watermark_id), -1) FROM compactions WHERE session_id = ?
  `, [sessionId]);
  const currentWm = wmRows[0][0];

  const toSummarize = await queryAll(sqlite3, db, `
    SELECT role, content, tool_calls, tool_call_id FROM messages
    WHERE session_id = ? AND COALESCE(in_context, 1) = 1 AND id > ? AND id <= ?
    ORDER BY id ASC
  `, [sessionId, currentWm, plan.watermarkId]);

  if (toSummarize.length === 0) return null;

  // Rolling: the previous summary (seq = current − 1) if any.
  const prevRows = await queryAll(sqlite3, db, `
    SELECT seq, summary FROM compactions WHERE session_id = ? ORDER BY seq DESC LIMIT 1
  `, [sessionId]);
  const prev = prevRows[0]; // [seq, summary] | undefined

  const prompt = buildSummaryPrompt({
    isUpdate: !!prev,
    prevSummary: prev ? prev[1] : '',
    messages: toSummarize,
    instructions,
    cap: summaryCap(window),
  });

  const summary = await fetchSummary(llmCfg, prompt, signal);
  if (!summary) {
    console.warn(`[compaction] ${reason}: LLM returned an empty summary (session ${sessionId})`);
    return null;
  }

  const newSeq = prev ? prev[0] + 1 : 0;
  await execParams(sqlite3, db, `
    INSERT INTO compactions (session_id, seq, summary, watermark_id)
    VALUES (?, ?, ?, ?)
  `, [sessionId, newSeq, summary, plan.watermarkId]);

  console.log(`[compaction] ${reason}: seq=${newSeq} watermark=${plan.watermarkId} summarized=${toSummarize.length} (session ${sessionId})`);
  return { seq: newSeq, watermarkId: plan.watermarkId, summary, summarizedCount: toSummarize.length };
}

/**
 * Rebuild the LLM context JSON from v_active_context — the SAME shape the
 * agent_think trigger builds (an array of { role, content, tool_calls,
 * tool_call_id }). Used by the reactive trigger to rebuild after a compaction.
 */
export async function queryActiveContextJson(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `
    SELECT json_group_array(json_object(
      'role', CASE WHEN role = 'tool' THEN 'tool' ELSE role END,
      'content', COALESCE(content, ''),
      'tool_calls', CASE WHEN role = 'assistant' AND tool_calls IS NOT NULL THEN json(tool_calls) ELSE NULL END,
      'tool_call_id', CASE WHEN role = 'tool' AND tool_call_id IS NOT NULL THEN tool_call_id ELSE NULL END
    )) AS ctx FROM v_active_context
  `);
  return rows.length ? rows[0][0] : '[]';
}
