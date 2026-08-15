// Ticket 2 compaction probe — end-to-end verification of interval compaction
// against the LIVE page (real agent DB, real UI paths: form submit, session
// switcher, /compact command). The LLM is FAKE: window.fetch is monkey-patched
// to route by request body — the one-shot summary call (no `tools`) gets a
// canned tau-schema summary; chat calls (with `tools`) get an SSE tool-call
// then an SSE final answer, so real assistant+tool pairs flow through the real
// trigger cascade (execute_tool really runs the SQL).
//
// Run in the browser (Vite dev server :5174):
//   import('/docs/prototypes/ticket-2-compaction-probe.mjs')
//     .then(m => m.runT2Probe())
//
// Uses a dedicated probe session (created + deleted by the probe); the default
// session is untouched. effective_context_window is set to 8000 for the probe
// (threshold 6800, tail budget 4800) and restored afterwards.
//
// Returns { ok, steps: {...} }.
import {
  deleteSession, forkSession, setSuppressCascade,
} from '/src/schema.js';
import {
  estimateActiveContextTokens, resolveContextWindow,
  COMPACTION_THRESHOLD,
} from '/src/compaction.js';

const SESSION = 't2_probe';

export async function runT2Probe() {
  const R = { steps: {} };
  const { sqlite3, db } = window.__agent;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const q = async (sql, params = []) => {
    const rows = [];
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params);
      while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
    }
    return rows;
  };
  const exec = async (sql, params = []) => {
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params);
      await sqlite3.step(stmt);
    }
  };

  const input = document.getElementById('user-input');
  const form = document.getElementById('input-form');
  const sessionSelect = document.getElementById('session-select');
  const statusBar = document.getElementById('status-bar');

  // ── Fake LLM ──────────────────────────────────────────────────────
  const CANNED_SUMMARY =
    '## Goal\nProbe goal.\n## Constraints & Preferences\nNone.\n## Progress\n' +
    '### Done\nSeeded conversation.\n### In Progress\nNone.\n### Blocked\nNone.\n' +
    '## Key Decisions\nNone.\n## Next Steps\nContinue.\n## Critical Context\nTable sample_data.';

  let reactiveMode = false;        // next chat call → 400 context-length
  let responsesSinceTurn = 0;      // non-400 chat responses since turn start
  const summaryPrompts = [];       // every summary-call prompt (for assertions)

  const sse = (payloadLines) => payloadLines.join('\n');
  const sseToolCall = () => sse([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_probe_1', function: { name: 'execute_sql', arguments: '{"query":"SELECT COUNT(*) AS c FROM sample_data"}' } }] } }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 10 } })}`,
    '',
    'data: [DONE]',
    '',
  ]);
  const sseFinal = () => sse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'The count is 4.' } }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 8 } })}`,
    '',
    'data: [DONE]',
    '',
  ]);

  const realFetch = window.fetch;
  window.fetch = async (url, opts = {}) => {
    if (typeof url !== 'string' || !url.includes('chat/completions')) {
      return realFetch(url, opts); // never touch non-LLM traffic
    }
    const body = JSON.parse(opts.body || '{}');
    if (!body.tools) {
      // One-shot compaction summary call (no tools).
      summaryPrompts.push(body.messages[1].content);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: CANNED_SUMMARY } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Chat completion (ask_llm).
    if (reactiveMode) {
      reactiveMode = false;
      return new Response(
        JSON.stringify({ error: { message: 'prompt is too long: 200000 tokens > 128000 maximum context window' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    responsesSinceTurn++;
    return new Response(
      responsesSinceTurn === 1 ? sseToolCall() : sseFinal(),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  // ── UI helpers ────────────────────────────────────────────────────
  async function switchSession(id) {
    if (!Array.from(sessionSelect.options).some(o => o.value === id)) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      sessionSelect.appendChild(opt);
    }
    sessionSelect.value = id;
    sessionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(400); // setActiveSession + renderMessages
  }

  async function submit(text) {
    responsesSinceTurn = 0;
    input.value = text;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 900; i++) {
      if (!input.disabled) break;
      await sleep(50);
    }
    if (input.disabled) throw new Error('turn did not complete: ' + text);
    await sleep(250); // let renderMessages settle
  }

  // Seed one user+assistant turn (cascade suppressed — no LLM involved).
  async function seedTurn(label) {
    const userText = `${label} question: ` + 'A'.repeat(1800);
    const asstText = `${label} answer: ` + 'B'.repeat(1800);
    await exec(`INSERT INTO messages (session_id, role, content, prompt_tokens, completion_tokens) VALUES (?, 'user', ?, 0, 0)`, [SESSION, userText]);
    await exec(`INSERT INTO messages (session_id, role, content, prompt_tokens, completion_tokens) VALUES (?, 'assistant', ?, 1000, 50)`, [SESSION, asstText]);
  }

  // Set the provider anchor: the latest assistant row's prompt_tokens.
  async function setAnchor(promptTokens) {
    await exec(`UPDATE messages SET prompt_tokens = ? WHERE id = (
      SELECT MAX(id) FROM messages WHERE session_id = ? AND role = 'assistant' AND prompt_tokens > 0
    )`, [promptTokens, SESSION]);
  }

  async function viewRows() {
    return q(`SELECT ctx_order, id, role, substr(COALESCE(content, ''), 1, 80)
              FROM v_active_context WHERE session_id = ? ORDER BY ctx_order ASC`, [SESSION]);
  }

  // Pair-safety: tail starts at a user row; every tool row is immediately
  // preceded by an assistant row (the cascade's assistant→tool ordering).
  function pairSafe(rows) {
    if (!rows.length) return false;
    if (rows[0][2] !== 'user') return false;
    let prev = null;
    for (const r of rows) {
      if (r[2] === 'tool' && !(prev && prev[2] === 'assistant')) return false;
      prev = r;
    }
    return true;
  }

  const compactionsOf = (sid) =>
    q(`SELECT seq, watermark_id FROM compactions WHERE session_id = ? ORDER BY seq ASC`, [sid]);

  let forkId = null;
  let originalWindow = null;
  try {
    // ── Setup ───────────────────────────────────────────────────────
    originalWindow = (await q(`SELECT value FROM system_config WHERE key = 'effective_context_window'`))[0][0];
    await exec(`UPDATE system_config SET value = '8000' WHERE key = 'effective_context_window'`);
    const stored = (await q(`SELECT value FROM system_config WHERE key = 'effective_context_window'`))[0][0];
    R.steps.setup = {
      window: resolveContextWindow(stored, 'gemini-2.5-flash'), // override beats cloud lookup
      threshold: Math.floor(8000 * COMPACTION_THRESHOLD),
    };

    await exec(`INSERT INTO sessions (id, name) VALUES (?, 't2 probe')`, [SESSION]);
    await switchSession(SESSION);

    // Seed 10 turns (~9.2k tokens) with the cascade suppressed.
    await setSuppressCascade(sqlite3, db, true);
    try {
      for (let i = 0; i < 10; i++) await seedTurn(`seed-${i}`);
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    // ── S0: view before compaction = [20 seeded rows], no summary ─────
    // (New sessions have no system row — only 'default' is seeded with
    // id=0; the view's system branch is "if present".)
    {
      const rows = await viewRows();
      R.steps.s0_view_before = {
        rowCount: rows.length,
        firstIsUser: rows[0][2] === 'user',
        noSummaryRow: !rows.some(r => r[1] === -1),
        messageRows: rows.length, // 20 seeded
      };
    }

    // ── S1: provider-anchored estimate over threshold ───────────────
    {
      await setAnchor(7000); // simulate the provider reporting a 7k prompt
      const est = await estimateActiveContextTokens(sqlite3, db, SESSION);
      R.steps.s1_estimate = { est, overThreshold: est > 8000 * COMPACTION_THRESHOLD };
    }

    // ── S2: proactive compaction fires at turn start (real UI turn) ─
    {
      await submit('Q1: count the rows');
      const comps = await compactionsOf(SESSION);
      const rows = await viewRows();
      const tail = rows.filter(r => r[1] > 0); // exclude system(0) + summary(-1)
      const summaryRow = rows.find(r => r[1] === -1);
      R.steps.s2_proactive = {
        compactionSeq0: comps.length === 1 && comps[0][0] === 0,
        watermark: comps[0]?.[1],
        viewShape: [rows[0][2], rows[1][2], rows[2][2]], // system, user(summary), user(tail head)
        summaryWrapped: !!summaryRow && summaryRow[3].startsWith('Previous conversation summary:\n' + CANNED_SUMMARY.slice(0, 20)),
        tailStartsAtUser: tail.length > 0 && tail[0][2] === 'user',
        pairSafe: pairSafe(tail),
        tailRows: tail.length, // 10 seeded tail rows + 4 Q1 rows
        dividerInDom: document.querySelectorAll('.compaction-divider').length === 1,
        q1Completed: (await q(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND content = 'The count is 4.'`, [SESSION]))[0][0] === 1,
      };
    }

    // ── S3: rolling second compaction folds the previous summary ────
    {
      await setSuppressCascade(sqlite3, db, true);
      try {
        for (let i = 0; i < 8; i++) await seedTurn(`seed2-${i}`);
      } finally {
        await setSuppressCascade(sqlite3, db, false);
      }
      await setAnchor(7000);
      summaryPrompts.length = 0;
      await submit('Q2: count again');
      const comps = await compactionsOf(SESSION);
      const rows = await viewRows();
      const summaries = rows.filter(r => r[1] === -1);
      const prompt = summaryPrompts[0] || '';
      R.steps.s3_rolling = {
        twoCompactions: comps.length === 2 && comps[0][0] === 0 && comps[1][0] === 1,
        watermarkAdvanced: comps.length === 2 && comps[1][1] > comps[0][1],
        oneSummaryInView: summaries.length === 1,
        promptIsUpdate: prompt.includes('<previous-summary>') && prompt.includes(CANNED_SUMMARY.slice(0, 40)),
        // The rolling prompt covers (wm0, wm1] — rows up to the cut point, NOT
        // the retained tail: seed2-0 (early) is in, seed-0 (covered by the
        // previous summary) is out.
        promptHasNewRowsOnly: prompt.includes('seed2-0') && !prompt.includes('seed-0 question'),
        tailStartsAtUser: (() => { const tail = rows.filter(r => r[1] > 0); return tail.length > 0 && tail[0][2] === 'user'; })(),
        dividersInDom: document.querySelectorAll('.compaction-divider').length === 2,
      };
    }

    // ── S4: reactive — 400 context-length → compact → retry once ────
    // The region after wm1 is ≈ the tail the S3 compaction kept (~4.8k tokens)
    // — too small for a valid cut (walk-back can't leave a ≥1-row prefix).
    // Seed more so the region comfortably exceeds the keep budget.
    {
      await setSuppressCascade(sqlite3, db, true);
      try {
        for (let i = 0; i < 4; i++) await seedTurn(`seed4-${i}`);
      } finally {
        await setSuppressCascade(sqlite3, db, false);
      }
      await setAnchor(500); // under threshold → proactive must NOT fire
      reactiveMode = true;
      summaryPrompts.length = 0;
      await submit('Q3: count once more');
      const comps = await compactionsOf(SESSION);
      const rows = await viewRows();
      const tail = rows.filter(r => r[1] > 0);
      R.steps.s4_reactive = {
        compactionSeq2: comps.length === 3 && comps[2][0] === 2,
        turnCompleted: (await q(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND content = 'The count is 4.'`, [SESSION]))[0][0] === 3,
        noErrorRow: (await q(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND instr(content, 'Turn failed') > 0`, [SESSION]))[0][0] === 0,
        tailStartsAtUser: tail.length > 0 && tail[0][2] === 'user',
        pairSafe: pairSafe(tail),
      };
    }

    // ── S5: manual /compact [instructions] — summarize everything ───
    {
      const lastVisibleId = (await q(
        `SELECT MAX(id) FROM messages WHERE session_id = ? AND COALESCE(in_context, 1) = 1`, [SESSION]))[0][0];
      summaryPrompts.length = 0;
      await submit('/compact focus on pricing');
      const comps = await compactionsOf(SESSION);
      const rows = await viewRows();
      const prompt = summaryPrompts[0] || '';
      R.steps.s5_manual = {
        compactionSeq3: comps.length === 4 && comps[3][0] === 3,
        watermarkIsLastVisible: comps[3]?.[1] === lastVisibleId,
        // No system row in this session → the view is the summary alone.
        viewIsSummaryOnly: rows.length === 1 && rows[0][1] === -1 && rows[0][2] === 'user',
        promptHasFocus: prompt.includes('Additional focus: focus on pricing'),
        promptIsUpdate: prompt.includes('<previous-summary>'),
        statusOk: statusBar.textContent.includes('Context compacted'),
      };
    }

    // ── S6: bare /compact after seeding more turns ──────────────────
    {
      await setSuppressCascade(sqlite3, db, true);
      try {
        for (let i = 0; i < 3; i++) await seedTurn(`seed3-${i}`);
      } finally {
        await setSuppressCascade(sqlite3, db, false);
      }
      const lastVisibleId = (await q(
        `SELECT MAX(id) FROM messages WHERE session_id = ? AND COALESCE(in_context, 1) = 1`, [SESSION]))[0][0];
      await submit('/compact');
      const comps = await compactionsOf(SESSION);
      const rows = await viewRows();
      R.steps.s6_manual_bare = {
        compactionSeq4: comps.length === 5 && comps[4][0] === 4,
        watermarkIsLastVisible: comps[4]?.[1] === lastVisibleId,
        viewIsSummaryOnly: rows.length === 1 && rows[0][1] === -1,
      };
    }

    // ── S7: /compact with nothing new → no-op ───────────────────────
    {
      const before = (await q(`SELECT COUNT(*) FROM compactions WHERE session_id = ?`, [SESSION]))[0][0];
      await submit('/compact');
      const after = (await q(`SELECT COUNT(*) FROM compactions WHERE session_id = ?`, [SESSION]))[0][0];
      R.steps.s7_manual_noop = {
        noNewRow: before === after,
        statusNothing: statusBar.textContent.includes('Nothing to compact'),
      };
    }

    // ── S8: fork copies only compactions at/before the fork point ───
    {
      // Fork point = the Q1 turn's final assistant row (after wm0, before wm1).
      const forkPointId = (await q(
        `SELECT id FROM messages WHERE session_id = ? AND content = 'The count is 4.' ORDER BY id ASC LIMIT 1`, [SESSION]))[0][0];
      const comps = await compactionsOf(SESSION);
      forkId = await forkSession(sqlite3, db, SESSION, forkPointId, 't2 fork');
      const forkComps = await compactionsOf(forkId);
      const forkMsgs = (await q(`SELECT COUNT(*) FROM messages WHERE session_id = ?`, [forkId]))[0][0];
      // Remapped watermark must point at a real fork message, and the fork's
      // tail (rows after it) must be the 14 rows after wm0: seed-5..9 (10)
      // + the Q1 turn (4), starting at the seed-5 user row.
      const wm = forkComps[0]?.[1];
      const tailInfo = wm === undefined ? null : (await q(
        `SELECT COUNT(*), (SELECT role FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT 1)
         FROM messages WHERE session_id = ? AND id > ?`, [forkId, wm, forkId, wm]))[0];
      R.steps.s8_fork = {
        forkPointBetweenWm0AndWm1: comps.length >= 2 && wm !== undefined && wm > 0,
        forkHasOnlySeq0: forkComps.length === 1 && forkComps[0][0] === 0,
        forkMessageCount: forkMsgs,
        watermarkRemapped: wm !== undefined && (await q(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND id = ?`, [forkId, wm]))[0][0] === 1,
        forkTailAfterWm0: tailInfo?.[0] === 14 && tailInfo?.[1] === 'user',
      };
    }

    // ── S9: deleteSession removes compactions ───────────────────────
    {
      await deleteSession(sqlite3, db, forkId);
      R.steps.s9_delete = {
        compactionsGone: (await q(`SELECT COUNT(*) FROM compactions WHERE session_id = ?`, [forkId]))[0][0] === 0,
        sessionGone: (await q(`SELECT COUNT(*) FROM sessions WHERE id = ?`, [forkId]))[0][0] === 0,
      };
      forkId = null;
    }

    // ── Cleanup ─────────────────────────────────────────────────────
    await switchSession('default');
    await deleteSession(sqlite3, db, SESSION);
  } catch (e) {
    R.fatal = e.name + ': ' + e.message;
    R.stack = String(e.stack).slice(0, 1200);
  } finally {
    window.fetch = realFetch;
    try {
      if (originalWindow !== null) {
        await exec(`UPDATE system_config SET value = ? WHERE key = 'effective_context_window'`, [originalWindow]);
      }
      if (forkId) await deleteSession(sqlite3, db, forkId);
      await deleteSession(sqlite3, db, SESSION);
      await setSuppressCascade(sqlite3, db, false);
      await switchSession('default');
    } catch { /* best-effort cleanup */ }
  }

  R.ok = !R.fatal
    && R.steps.setup?.window === 8000
    && R.steps.s0_view_before?.firstIsUser && R.steps.s0_view_before?.noSummaryRow
    && R.steps.s0_view_before?.messageRows === 20
    && R.steps.s1_estimate?.overThreshold
    && R.steps.s2_proactive?.compactionSeq0 && R.steps.s2_proactive?.summaryWrapped
    && R.steps.s2_proactive?.tailStartsAtUser && R.steps.s2_proactive?.pairSafe
    && R.steps.s2_proactive?.dividerInDom && R.steps.s2_proactive?.q1Completed
    && R.steps.s3_rolling?.twoCompactions && R.steps.s3_rolling?.watermarkAdvanced
    && R.steps.s3_rolling?.oneSummaryInView && R.steps.s3_rolling?.promptIsUpdate
    && R.steps.s3_rolling?.promptHasNewRowsOnly && R.steps.s3_rolling?.dividersInDom
    && R.steps.s4_reactive?.compactionSeq2 && R.steps.s4_reactive?.turnCompleted
    && R.steps.s4_reactive?.noErrorRow && R.steps.s4_reactive?.pairSafe
    && R.steps.s5_manual?.compactionSeq3 && R.steps.s5_manual?.watermarkIsLastVisible
    && R.steps.s5_manual?.viewIsSummaryOnly && R.steps.s5_manual?.promptHasFocus
    && R.steps.s6_manual_bare?.compactionSeq4 && R.steps.s6_manual_bare?.watermarkIsLastVisible
    && R.steps.s6_manual_bare?.viewIsSummaryOnly
    && R.steps.s7_manual_noop?.noNewRow && R.steps.s7_manual_noop?.statusNothing
    && R.steps.s8_fork?.forkHasOnlySeq0 && R.steps.s8_fork?.watermarkRemapped
    && R.steps.s8_fork?.forkMessageCount === 24 && R.steps.s8_fork?.forkTailAfterWm0
    && R.steps.s9_delete?.compactionsGone && R.steps.s9_delete?.sessionGone;
  return R;
}
