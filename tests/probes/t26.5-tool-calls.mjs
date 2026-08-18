// Ticket 26.5 (subsystem 4) — differential output-equality probe: the
// refactored toolCallQueries map (built from v_tool_call_queries) must
// contain exactly what the pre-T26.5 JSON.parse loop produced.
//
// Oracle: the old chat-render.js tool-calls loop, verbatim (parses each
//   assistant message's tool_calls JSON, double-parses arguments, and maps
//   tool_call_id → args.query for truthy queries).
// Actual: the T26.5 view query — SELECT tool_call_id, query_sql FROM
//   v_tool_call_queries WHERE session_id=? AND query_sql IS NOT NULL AND
//   query_sql <> '' (the filter mirrors the old `if (args?.query)` guard).
//
// The seed covers every argument shape + corruption the old loop tolerated:
// object args, string args, no-query-key, empty query, missing id, missing
// arguments, non-assistant rows, malformed INNER arguments string, multi-call
// rows, NULL tool_calls, and a duplicate id across two messages (last-wins
// ordering). (A numeric `query` is not seeded: queries are strings by contract,
// so the old loop's numeric-falsy exclusion is out of the realistic shape.)
//
// NOTE: a malformed or non-array OUTER tool_calls is NOT seeded here — the
// execute_tool trigger's WHEN clause calls json_array_length(NEW.tool_calls)
// on every assistant INSERT, so such a row cannot be created through the
// normal write path (it is an enforced-unreachable state; the view's outer
// json_valid guard is read-path defense-in-depth for external corruption,
// e.g. a hand-edited cartridge).
//
// A dedicated session isolates the seed; cascade/capture are suppressed
// (messages is a captured table) and everything is cleaned up in `finally`.
//
// Run from the harness (tests/specs/t26.5-tool-calls.spec.mjs) or the
// preview console:
//   import('/tests/probes/t26.5-tool-calls.mjs?t=' + Date.now())
//     .then(m => m.runT265ToolCallsProbe(window.__agent.sqlite3, window.__agent.db))

import { queryAll } from '../../src/schema.js';

const SESSION = 't265_tc';

// [role, content, tool_calls]
const SEED = [
  // object args with a query
  ['assistant', null, JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'execute_sql', arguments: { query: 'SELECT 1' } } }])],
  // string-form args with a query
  ['assistant', null, JSON.stringify([{ id: 'c2', type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query: 'hello world' }) } }])],
  // object args, no query key (url only) → no entry
  ['assistant', null, JSON.stringify([{ id: 'c3', type: 'function', function: { name: 'fetch_url', arguments: { url: 'https://x' } } }])],
  // object args, empty query (falsy) → no entry
  ['assistant', null, JSON.stringify([{ id: 'c4', type: 'function', function: { name: 'execute_sql', arguments: { query: '' } } }])],
  // tool call with no id → no entry
  ['assistant', null, JSON.stringify([{ type: 'function', function: { name: 'execute_sql', arguments: { query: 'SELECT 2' } } }])],
  // tool call with no arguments → no entry
  ['assistant', null, JSON.stringify([{ id: 'c8', type: 'function', function: { name: 'execute_sql' } }])],
  // non-assistant row with tool_calls → ignored
  ['user', null, JSON.stringify([{ id: 'c9', type: 'function', function: { name: 'execute_sql', arguments: { query: 'SELECT 9' } } }])],
  // malformed INNER arguments string → old loop skips just this call; view
  // yields query_sql NULL (the T26.5 sub4 json_valid guard) → no entry
  ['assistant', null, JSON.stringify([{ id: 'c10', type: 'function', function: { name: 'execute_sql', arguments: '{bad json' } }])],
  // multiple tool calls in one message → both entries
  ['assistant', null, JSON.stringify([
    { id: 'c11a', type: 'function', function: { name: 'execute_sql', arguments: { query: 'SELECT 11a' } } },
    { id: 'c11b', type: 'function', function: { name: 'execute_sql', arguments: { query: 'SELECT 11b' } } },
  ])],
  // NULL tool_calls → ignored
  ['assistant', null, null],
  // duplicate id across two messages → last (by message_id) wins
  ['assistant', null, JSON.stringify([{ id: 'dup', type: 'function', function: { name: 'execute_sql', arguments: { query: 'FIRST' } } }])],
  ['assistant', null, JSON.stringify([{ id: 'dup', type: 'function', function: { name: 'execute_sql', arguments: { query: 'SECOND' } } }])],
];

/** The pre-T26.5 tool-calls loop, verbatim (rows are [id, role, content, tool_calls, ...]). */
function oracleToolCallQueries(rows) {
  const toolCallQueries = new Map();
  for (const [, role, , toolCallsJson] of rows) {
    if (role === 'assistant' && toolCallsJson) {
      try {
        const tcs = JSON.parse(toolCallsJson);
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            if (tc?.id && tc?.function?.arguments) {
              try {
                const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
                if (args?.query) toolCallQueries.set(tc.id, args.query);
              } catch { /* parse error */ }
            }
          }
        }
      } catch { /* json parse error */ }
    }
  }
  return toolCallQueries;
}

/** The T26.5 view-backed map (mirrors the refactored chat-render.js). */
async function actualToolCallQueries(sqlite3, db, sessionId) {
  const toolCallQueries = new Map();
  for (const [tcId, q] of await queryAll(sqlite3, db,
    `SELECT tool_call_id, query_sql FROM v_tool_call_queries
     WHERE session_id = ?
       AND tool_call_id IS NOT NULL
       AND query_sql IS NOT NULL AND query_sql <> ''
     ORDER BY message_id ASC, call_index ASC`, [sessionId])) {
    toolCallQueries.set(tcId, q);
  }
  return toolCallQueries;
}

function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k) || b.get(k) !== v) return false;
  }
  return true;
}

export async function runT265ToolCallsProbe(sqlite3, db) {
  const R = { ok: false, steps: {} };
  const ids = [];
  try {
    await queryAll(sqlite3, db, [
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_capture'`,
    ].join('; '));

    await queryAll(sqlite3, db,
      `INSERT OR IGNORE INTO sessions (id, name) VALUES (?, ?)`, [SESSION, 't265 tool-calls probe']);

    for (const [role, content, toolCalls] of SEED) {
      await queryAll(sqlite3, db,
        `INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?, ?, ?, ?)`,
        [SESSION, role, content, toolCalls]);
      const r = await queryAll(sqlite3, db, `SELECT last_insert_rowid()`);
      ids.push(r[0][0]);
    }

    // Oracle over the raw rows (same shape renderMessages fetched).
    const rows = await queryAll(sqlite3, db,
      `SELECT id, role, content, tool_calls, tool_call_id, created_at
       FROM messages WHERE session_id = ? ORDER BY id ASC`, [SESSION]);
    const oracle = oracleToolCallQueries(rows);
    const actual = await actualToolCallQueries(sqlite3, db, SESSION);

    R.steps.mapEquality = {
      ok: mapsEqual(oracle, actual),
      oracle: [...oracle.entries()],
      actual: [...actual.entries()],
    };

    R.steps.spotChecks = {
      ok:
        actual.get('c1') === 'SELECT 1' &&          // object args
        actual.get('c2') === 'hello world' &&       // string args
        !actual.has('c3') &&                        // no query key
        !actual.has('c4') &&                        // empty query
        !actual.has('c9') &&                        // non-assistant ignored
        !actual.has('c10') &&                       // malformed inner args
        actual.get('c11a') === 'SELECT 11a' &&      // multi-call
        actual.get('c11b') === 'SELECT 11b' &&
        actual.get('dup') === 'SECOND',             // last-wins
      c1: actual.get('c1'), c2: actual.get('c2'), dup: actual.get('dup'),
    };

    R.ok = R.steps.mapEquality.ok && R.steps.spotChecks.ok;
    return R;
  } finally {
    for (const id of ids) {
      await queryAll(sqlite3, db, `DELETE FROM messages WHERE id = ?`, [id]).catch(() => {});
    }
    await queryAll(sqlite3, db, `DELETE FROM sessions WHERE id = ?`, [SESSION]).catch(() => {});
    await queryAll(sqlite3, db, [
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_capture'`,
    ].join('; ')).catch(() => {});
  }
}
