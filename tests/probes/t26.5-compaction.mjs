// Ticket 26.5 (subsystem 2) — differential output-equality probe: the
// refactored planCompaction / estimateActiveContextTokens (v_turn_boundaries)
// must return exactly what the pre-T26.5 JS walk-back returned.
//
// The oracles below are the old algorithms verbatim (JS walk-back + the
// chars÷4 estimator; the v_active_context sum for the estimate).
//
// Seeds are ASCII-only on purpose: the view's est_tokens uses LENGTH()
// (UTF-8 bytes) vs the JS estimator's .length (UTF-16 units) — identical for
// ASCII, a documented bounded difference otherwise (the estimate is rough by
// design).
//
// Phases (cascade + capture suppressed; brain left clean afterwards):
//   A. no compaction: plans + estimates over a budget sweep
//   B. a compaction row present (watermark mid-conversation): the region
//      shrinks, the summary row enters the no-anchor estimate, and a huge
//      budget exercises the tau guard (first retained row = region head → null)
//
// Run from the harness (tests/specs/t26.5-compaction.spec.mjs) or the
// preview console:
//   import('/tests/probes/t26.5-compaction.mjs?t=' + Date.now())
//     .then(m => m.runT265CompactionProbe(window.__agent.sqlite3, window.__agent.db))

import { planCompaction, estimateActiveContextTokens } from '../../src/compaction.js';
import { queryAll } from '../../src/schema.js';

const S = (ch, n) => ch.repeat(n); // ASCII filler

// role, content, tool_calls, tool_call_id — a 3-turn conversation with
// tool pairs (the pair-safety the watermark rule protects).
const SEED = [
  ['user', S('u', 120), null, null],
  ['assistant', S('a', 80), JSON.stringify([{ id: 'call_t265_p1', type: 'function', function: { name: 'execute_sql', arguments: JSON.stringify({ query: 'SELECT 1' }) } }]), null],
  ['tool', S('t', 60), null, 'call_t265_p1'],
  ['user', S('v', 200), null, null],
  ['assistant', S('b', 40), null, null],
  ['user', S('w', 150), null, null],
  ['assistant', S('c', 90), JSON.stringify([{ id: 'call_t265_p2', type: 'function', function: { name: 'search_web', arguments: { query: 't265 compaction probe' } } }]), null],
  ['tool', S('x', 300), null, 'call_t265_p2'],
];

/** The compaction estimator, verbatim from the pre-T26.5 compaction.js. */
function estTokens(content, toolCalls, toolCallId) {
  let chars = 0;
  if (content) chars += String(content).length;
  if (toolCalls) chars += String(toolCalls).length;
  if (toolCallId) chars += String(toolCallId).length;
  return Math.ceil(chars / 4);
}

/** The pre-T26.5 planCompaction, verbatim (JS walk-back). */
async function oraclePlan(sqlite3, db, sessionId, keepBudget) {
  const wmRows = await queryAll(sqlite3, db, `
    SELECT COALESCE(MAX(watermark_id), -1) FROM compactions WHERE session_id = ?
  `, [sessionId]);
  const currentWm = wmRows[0][0];

  const rows = await queryAll(sqlite3, db, `
    SELECT id, role, content, tool_calls, tool_call_id FROM messages
    WHERE session_id = ? AND COALESCE(in_context, 1) = 1 AND id > ?
    ORDER BY id ASC
  `, [sessionId, currentWm]);

  if (rows.length === 0) return null;

  if (keepBudget <= 0) {
    const last = rows[rows.length - 1];
    return { watermarkId: last[0], firstRetainedId: null, summarizedCount: rows.length, keepBudget: 0 };
  }

  let acc = 0;
  let cutIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    acc += estTokens(rows[i][2], rows[i][3], rows[i][4]);
    if (acc >= keepBudget) { cutIndex = i; break; }
  }
  if (cutIndex === -1) return null;

  let firstRetainedIndex = -1;
  if (rows[cutIndex][1] === 'user') {
    firstRetainedIndex = cutIndex;
  } else {
    for (let j = cutIndex + 1; j < rows.length; j++) {
      if (rows[j][1] === 'user') { firstRetainedIndex = j; break; }
    }
    if (firstRetainedIndex === -1) {
      for (let i = cutIndex; i >= 0; i--) {
        if (rows[i][1] === 'user') { firstRetainedIndex = i; break; }
      }
    }
  }
  if (firstRetainedIndex === -1) return null;
  if (firstRetainedIndex === 0) return null;

  return {
    watermarkId: rows[firstRetainedIndex - 1][0],
    firstRetainedId: rows[firstRetainedIndex][0],
    summarizedCount: firstRetainedIndex,
    keepBudget,
  };
}

/** The pre-T26.5 estimateActiveContextTokens, verbatim (v_active_context sum). */
async function oracleEstimate(sqlite3, db, sessionId) {
  const anchorRows = await queryAll(sqlite3, db, `
    SELECT id, prompt_tokens FROM messages
    WHERE session_id = ? AND role = 'assistant' AND prompt_tokens > 0
    ORDER BY id DESC LIMIT 1
  `, [sessionId]);
  const anchor = anchorRows[0];

  const ctx = await queryAll(sqlite3, db, `
    SELECT id, content, tool_calls, tool_call_id FROM v_active_context
    WHERE session_id = ? ORDER BY ctx_order ASC
  `, [sessionId]);

  let est = 0;
  if (anchor) {
    est = anchor[1];
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

async function comparePlans(sqlite3, db, sessionId, budgets, label) {
  const out = [];
  for (const keepBudget of budgets) {
    const oracle = await oraclePlan(sqlite3, db, sessionId, keepBudget);
    const actual = await planCompaction(sqlite3, db, sessionId, keepBudget);
    out.push({
      keepBudget,
      ok: JSON.stringify(oracle) === JSON.stringify(actual),
      oracle,
      actual,
    });
  }
  return { label, ok: out.every((r) => r.ok), results: out };
}

async function compareEstimates(sqlite3, db, sessionId, label) {
  const oracle = await oracleEstimate(sqlite3, db, sessionId);
  const actual = await estimateActiveContextTokens(sqlite3, db, sessionId);
  return { label, ok: oracle === actual, oracle, actual };
}

export async function runT265CompactionProbe(sqlite3, db) {
  const R = { ok: false, steps: {} };
  const sessionId = 'default';
  const ids = [];

  await queryAll(sqlite3, db, [
    `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`,
    `UPDATE session_context SET value = '1' WHERE key = 'suppress_capture'`,
  ].join('; '));

  try {
    // ── Seed the conversation ──
    for (const [role, content, toolCalls, toolCallId] of SEED) {
      await queryAll(sqlite3, db, `
        INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id)
        VALUES (?, ?, ?, ?, ?)
      `, [sessionId, role, content, toolCalls, toolCallId]);
      const idRows = await queryAll(sqlite3, db, `SELECT last_insert_rowid()`);
      ids.push(idRows[0][0]);
    }
    const [u1, a1, t1, u2, a2, u3, a3, t3] = ids;

    // ── Phase A: no compaction ──
    R.steps.estimateNoAnchor = await compareEstimates(sqlite3, db, sessionId, 'no compaction, no anchor');

    await queryAll(sqlite3, db, `UPDATE messages SET prompt_tokens = 1000 WHERE id = ?`, [a2]);
    R.steps.estimateAnchored = await compareEstimates(sqlite3, db, sessionId, 'no compaction, anchor at asst2');

    R.steps.plansNoCompaction = await comparePlans(
      sqlite3, db, sessionId, [0, 1, 50, 100, 200, 300, 1000, 100000], 'no compaction');

    // ── Phase B: a compaction row (watermark after turn 1) ──
    await queryAll(sqlite3, db, `
      INSERT INTO compactions (session_id, seq, summary, watermark_id)
      VALUES (?, 0, ?, ?)
    `, [sessionId, S('s', 300), t1]);

    R.steps.estimateNoAnchorWithCompaction = await compareEstimates(sqlite3, db, sessionId,
      'compaction present, no anchor (summary row in context)');
    R.steps.estimateAnchoredWithCompaction = await compareEstimates(sqlite3, db, sessionId,
      'compaction present, anchor at asst2');
    R.steps.plansWithCompaction = await comparePlans(
      sqlite3, db, sessionId, [0, 50, 200, 100000], 'compaction present');

    // The tau guard specifically: region head is a user row (u2) and a huge
    // budget cuts at the head → first retained row = region head → null.
    R.steps.tauGuard = {
      ok: R.steps.plansWithCompaction.results
        .find((r) => r.keepBudget === 100000).oracle === null
        && R.steps.plansWithCompaction.results
        .find((r) => r.keepBudget === 100000).actual === null,
    };

    R.ok = [
      R.steps.estimateNoAnchor,
      R.steps.estimateAnchored,
      R.steps.plansNoCompaction,
      R.steps.estimateNoAnchorWithCompaction,
      R.steps.estimateAnchoredWithCompaction,
      R.steps.plansWithCompaction,
      R.steps.tauGuard,
    ].every((s) => s.ok);
    return R;
  } finally {
    for (const id of ids) {
      await queryAll(sqlite3, db, `DELETE FROM messages WHERE id = ?`, [id]).catch(() => {});
    }
    await queryAll(sqlite3, db,
      `DELETE FROM compactions WHERE session_id = ? AND summary = ?`,
      [sessionId, S('s', 300)]).catch(() => {});
    await queryAll(sqlite3, db, [
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_capture'`,
    ].join('; ')).catch(() => {});
  }
}
