// Ticket 9 scratchpad probe — end-to-end verification of the ! / !! direct-SQL
// scratchpad against the LIVE page (real agent DB, real UI path: form submit
// + ⟲ button clicks, confirm() overridden).
//
// Run in the browser (Vite dev server :5174):
//   import('/docs/prototypes/ticket-9-scratchpad-probe.mjs')
//     .then(m => m.runT9Probe())
//
// It mutates the default session (adds scratchpad rows, temporarily modifies
// sample_data, creates/drops probe tables) and ends by restoring
// sample_data to its original 8 rows via a final scratchpad rewind.
//
// Returns { ok, steps: {...} }.
export async function runT9Probe() {
  const R = { steps: {}, confirms: [] };
  const { sqlite3, db } = window.__agent;
  const SESSION = 'default';

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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── confirm() override (accept/reject per step) ────────────────────
  const realConfirm = window.confirm;
  let confirmMode = true;
  window.confirm = (msg) => { R.confirms.push(String(msg).slice(0, 160)); return confirmMode; };

  // ── UI helpers ─────────────────────────────────────────────────────
  const form = document.getElementById('input-form');
  const input = document.getElementById('user-input');

  // Wait (DOM only — no DB calls mid-flight: single-threaded SQLite) until a
  // new scratchpad result bubble has rendered (renderMessages runs after the
  // input is re-enabled, so require BOTH conditions).
  async function waitForResult(before) {
    for (let i = 0; i < 300; i++) {
      if (!input.disabled &&
          document.querySelectorAll('.message.scratchpad-result').length > before) break;
      await sleep(100);
    }
    if (input.disabled) throw new Error('input still disabled after submit');
    if (document.querySelectorAll('.message.scratchpad-result').length <= before) {
      throw new Error('no scratchpad result bubble appeared');
    }
    await sleep(100); // let renderMessages settle
  }

  // Submit a scratchpad command through the REAL form path.
  async function sendCommand(text) {
    confirmMode = true;
    const before = document.querySelectorAll('.message.scratchpad-result').length;
    input.value = text;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitForResult(before);
  }

  // Click the ⟲ button on the NEWEST user bubble whose text starts with
  // `cmd` (earlier probe runs may have left same-text bubbles whose turns
  // were already consumed — only a bubble with a live ⟲ button works),
  // then wait (DOM only) for the rewind marker row to appear.
  async function clickRewind(cmdPrefix) {
    confirmMode = true;
    const bubbles = Array.from(document.querySelectorAll('.message.user'))
      .filter(b => b.textContent.trimStart().startsWith(cmdPrefix));
    const withBtn = bubbles.filter(b => b.querySelector('.rewind-btn'));
    const bubble = withBtn[withBtn.length - 1] || bubbles[bubbles.length - 1];
    if (!bubble) throw new Error('no user bubble for: ' + cmdPrefix);
    const btn = bubble.querySelector('.rewind-btn');
    if (!btn) throw new Error('no rewind button on bubble: ' + cmdPrefix);
    const markersBefore = markerCount();
    btn.click();
    for (let i = 0; i < 300; i++) {
      if (markerCount() > markersBefore) break;
      await sleep(100);
    }
    if (markerCount() <= markersBefore) throw new Error('no rewind marker after click: ' + cmdPrefix);
    await sleep(150);
  }

  const markerCount = () =>
    Array.from(document.querySelectorAll('.message.assistant'))
      .filter(el => el.textContent.includes('rewound to before scratchpad command')).length;

  // Latest scratchpad user row + its result row (envelope) for `cmd`.
  async function scratchpadRows(cmd) {
    const user = (await q(
      `SELECT id, in_context FROM messages WHERE session_id = ? AND role = 'user' AND content = ? ORDER BY id DESC LIMIT 1`,
      [SESSION, cmd]))[0] || null;
    const res = (await q(
      `SELECT id, in_context, content FROM messages WHERE session_id = ? AND role = 'assistant' AND instr(content, ?) > 0 ORDER BY id DESC LIMIT 1`,
      [SESSION, `"sql":"${cmd.replace(/^!+/, '')}"`]))[0] || null;
    return { user, res };
  }
  const parseEnv = (row) => { try { return JSON.parse(row[2]); } catch { return null; } };

  try {
    // ── Baseline ─────────────────────────────────────────────────────
    const baseRows = await q(`SELECT id, name, category, value FROM sample_data ORDER BY id`);
    const baseAssistantCount = (await q(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'assistant'`, [SESSION]))[0][0];
    R.steps.baseline = { sampleRows: baseRows.length, assistantCount: baseAssistantCount };

    // ── T1: !SELECT (shared read) ────────────────────────────────────
    {
      const cmd = '!SELECT * FROM sample_data ORDER BY id';
      await sendCommand(cmd);
      const { user, res } = await scratchpadRows(cmd);
      const env = res && parseEnv(res);
      const assistantCount = (await q(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'assistant'`, [SESSION]))[0][0];
      const domTable = document.querySelectorAll('.message.scratchpad-result .result-table').length > 0;
      R.steps.t1_read = {
        userRow: !!user, userInContext: user?.[1],
        resultRow: !!res, resultInContext: res?.[1],
        envOk: !!env && env.scratchpad === true && env.results?.length === 1,
        rowCount: env?.results?.[0]?.values?.length,
        onlyOneAssistantRow: assistantCount - baseAssistantCount === 1, // no LLM row
        domTableRendered: domTable,
      };
    }

    // ── T2: !UPDATE (shared write, confirm) ──────────────────────────
    {
      const cmd = '!UPDATE sample_data SET value = 0 WHERE id = 1';
      await sendCommand(cmd);
      const { user, res } = await scratchpadRows(cmd);
      const val = (await q(`SELECT value FROM sample_data WHERE id = 1`))[0][0];
      const M = user[0];
      const cs = await q(`SELECT table_name, op FROM turn_changesets WHERE session_id = ? AND turn_id = ?`, [SESSION, -M]);
      R.steps.t2_shared_write = {
        valNow: val,
        userInContext: user?.[1], resultInContext: res?.[1],
        changesetTurnNegM: cs.length === 1 && cs[0][0] === 'sample_data' && cs[0][1] === 'U',
      };
    }

    // ── T3: !!UPDATE (private write) ─────────────────────────────────
    {
      const cmd = '!!UPDATE sample_data SET value = 42 WHERE id = 2';
      await sendCommand(cmd);
      const { user, res } = await scratchpadRows(cmd);
      const val = (await q(`SELECT value FROM sample_data WHERE id = 2`))[0][0];
      const M = user[0];
      const cs = await q(`SELECT table_name, op FROM turn_changesets WHERE session_id = ? AND turn_id = ?`, [SESSION, -M]);
      R.steps.t3_private_write = {
        valNow: val,
        userInContext: user?.[1], resultInContext: res?.[1],
        changesetTurnNegM: cs.length === 1 && cs[0][0] === 'sample_data' && cs[0][1] === 'U',
      };
    }

    // ── T4: LLM-context exclusion (agent_think's exact subquery) ─────
    {
      const ctx = (await q(`
        SELECT COALESCE(json_group_array(content), '') FROM messages
        WHERE session_id = ? AND COALESCE(in_context, 1) = 1
      `, [SESSION]))[0][0];
      R.steps.t4_context = {
        sharedVisible: ctx.includes('!SELECT * FROM sample_data ORDER BY id'),
        privateHidden: !ctx.includes('!!UPDATE sample_data SET value = 42 WHERE id = 2'),
      };
    }

    // ── T5: !!CREATE TABLE + !!INSERT (DDL capture triggers) ─────────
    {
      await sendCommand('!!CREATE TABLE t9_probe (id INTEGER PRIMARY KEY, name TEXT, val REAL)');
      const ddl1 = (await q(`SELECT turn_id, table_name, pre_image FROM turn_ddl_log WHERE session_id = ? AND ddl_sql LIKE 'CREATE TABLE t9_probe%' ORDER BY id DESC LIMIT 1`, [SESSION]))[0];
      const trig = (await q(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_t9_probe_%'`))[0][0];

      const insCmd = "!!INSERT INTO t9_probe (name, val) VALUES ('a', 1.5), ('b', 2.5)";
      await sendCommand(insCmd);
      const insUser = (await q(`SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND content = ? ORDER BY id DESC LIMIT 1`, [SESSION, insCmd]))[0];
      const cs = (await q(`SELECT COUNT(*) FROM turn_changesets WHERE session_id = ? AND turn_id = ? AND table_name = 't9_probe' AND op = 'I'`, [SESSION, -insUser[0]]))[0][0];
      R.steps.t5_ddl_create = {
        ddlLogged: !!ddl1 && ddl1[1] === 't9_probe',
        captureTriggersAttached: trig === 3,
        insertChangesets: cs === 2,
      };
    }

    // ── T6: !!DROP TABLE (pre-image capture) ─────────────────────────
    {
      const cmd = '!!DROP TABLE t9_probe';
      await sendCommand(cmd);
      const ddl = (await q(`SELECT table_name, pre_image FROM turn_ddl_log WHERE session_id = ? AND ddl_sql = 'DROP TABLE t9_probe' ORDER BY id DESC LIMIT 1`, [SESSION]))[0];
      const pre = ddl?.[1] ? JSON.parse(ddl[1]) : null;
      const gone = (await q(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 't9_probe'`))[0][0];
      R.steps.t6_ddl_drop = {
        ddlLogged: !!ddl && ddl[0] === 't9_probe',
        preImageOk: !!pre && !!pre.create_sql && Array.isArray(pre.columns) && pre.rows?.length === 2,
        tableGone: gone === 0,
      };
    }

    // ── T7: ⟲ on the DROP bubble (table restored) ────────────────────
    {
      await clickRewind('!!DROP TABLE t9_probe');
      const rows = await q(`SELECT name, val FROM t9_probe ORDER BY name`);
      const trig = (await q(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_t9_probe_%'`))[0][0];
      const consumed = (await q(`SELECT COUNT(*) FROM turn_ddl_log WHERE session_id = ? AND ddl_sql = 'DROP TABLE t9_probe'`, [SESSION]))[0][0];
      R.steps.t7_rewind_drop = {
        tableRestored: rows.length === 2 && rows[0][0] === 'a' && rows[1][0] === 'b',
        triggersReswept: trig === 3,
        ddlLogConsumed: consumed === 0,
      };
    }

    // ── T8: KILLER TEST — !!DROP TABLE sample_data, then ⟲ ───────────
    {
      const before = await q(`SELECT id, value FROM sample_data ORDER BY id`);
      await sendCommand('!!DROP TABLE sample_data');
      const gone = (await q(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sample_data'`))[0][0];
      await clickRewind('!!DROP TABLE sample_data');
      const after = await q(`SELECT id, value FROM sample_data ORDER BY id`);
      const same = before.length === after.length && before.every((r, i) => r[0] === after[i][0] && r[1] === after[i][1]);
      R.steps.t8_kill = {
        beforeCount: before.length,
        tableGoneMidway: gone === 0,
        restoredExact: same,
      };
    }

    // ── T9: error path (bad table) ───────────────────────────────────
    {
      const cmd = '!!UPDATE no_such_table SET x = 1';
      await sendCommand(cmd);
      const users = await q(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user' AND content = ?`, [SESSION, cmd]);
      const err = (await q(`SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND instr(content, 'no such table') > 0 ORDER BY id DESC LIMIT 1`, [SESSION]))[0];
      const flags = await q(`SELECT (SELECT value FROM session_context WHERE key='suppress_cascade'), (SELECT value FROM session_context WHERE key='suppress_capture')`);
      R.steps.t9_error = {
        // >= 1: earlier probe runs may have left same-text user rows behind
        // (the rewind is data-only, history is preserved).
        userRowKept: users[0][0] >= 1,
        errorRow: !!err && err[0].includes('no such table'),
        flagsCleared: flags[0][0] === '0' && flags[0][1] === '0',
      };
    }

    // ── T10: forbidden (transaction control) ─────────────────────────
    {
      const cmd = '!!COMMIT';
      await sendCommand(cmd);
      const err = (await q(`SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND instr(content, 'Transaction-control') > 0 ORDER BY id DESC LIMIT 1`, [SESSION]))[0];
      R.steps.t10_forbidden = { errorRow: !!err };
    }

    // ── T11: cancel path (reject the confirm) ────────────────────────
    {
      const cmd = '!!DELETE FROM sample_data WHERE id = 3';
      confirmMode = false; // reject
      const before = document.querySelectorAll('.message.scratchpad-result').length;
      input.value = cmd;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await waitForResult(before);
      const row3 = (await q(`SELECT value FROM sample_data WHERE id = 3`))[0];
      const err = (await q(`SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND instr(content, 'Cancelled') > 0 ORDER BY id DESC LIMIT 1`, [SESSION]))[0];
      R.steps.t11_cancel = {
        row3Intact: !!row3,
        cancelledRow: !!err,
      };
    }

    // ── T12: 200-row cap on the persisted envelope ───────────────────
    {
      await sendCommand('!!CREATE TABLE t9_cap (id INTEGER PRIMARY KEY, x TEXT)');
      const vals = Array.from({ length: 250 }, (_, i) => `(${i}, 'r${i}')`).join(', ');
      await sendCommand(`!!INSERT INTO t9_cap (id, x) VALUES ${vals}`);
      await sendCommand('!SELECT * FROM t9_cap ORDER BY id');
      const res = (await q(`SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND instr(content, 't9_cap ORDER BY id') > 0 ORDER BY id DESC LIMIT 1`, [SESSION]))[0];
      const env = res ? JSON.parse(res[0]) : null;
      R.steps.t12_cap = {
        capped: env?.results?.[0]?.values?.length === 200,
        truncatedFlag: env?.results?.[0]?.truncated === true,
      };
      // cleanup: drop + rewind so no probe changesets linger
      await sendCommand('!!DROP TABLE t9_cap');
      await clickRewind('!!DROP TABLE t9_cap');
    }

    // ── T13: eviction windows (duplicate the evictChangesets SQL) ────
    {
      await exec(`INSERT INTO sessions (id, name) VALUES ('t9_evict', 'evict test')`);
      for (let i = 1; i <= 25; i++) {
        await exec(`INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid) VALUES (?, 't9_evict', 'x', 'I', 1)`, [i]);
        await exec(`INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid) VALUES (?, 't9_evict', 'x', 'I', 1)`, [-i]);
      }
      // Same SQL as schema.js evictChangesets (keepTurns = 20).
      const keepPos = `SELECT turn_id FROM (
        SELECT turn_id FROM turn_changesets WHERE session_id = 't9_evict' AND turn_id >= 0
        UNION SELECT turn_id FROM turn_ddl_log WHERE session_id = 't9_evict' AND turn_id >= 0
      ) ORDER BY turn_id DESC LIMIT 20`;
      const keepNeg = `SELECT turn_id FROM (
        SELECT turn_id FROM turn_changesets WHERE session_id = 't9_evict' AND turn_id < 0
        UNION SELECT turn_id FROM turn_ddl_log WHERE session_id = 't9_evict' AND turn_id < 0
      ) ORDER BY turn_id ASC LIMIT 20`;
      await exec(`DELETE FROM turn_changesets WHERE session_id = 't9_evict' AND turn_id >= 0 AND turn_id NOT IN (${keepPos})`);
      await exec(`DELETE FROM turn_changesets WHERE session_id = 't9_evict' AND turn_id < 0 AND turn_id NOT IN (${keepNeg})`);
      const pos = (await q(`SELECT turn_id FROM turn_changesets WHERE session_id = 't9_evict' AND turn_id >= 0 ORDER BY turn_id`)).map(r => r[0]);
      const neg = (await q(`SELECT turn_id FROM turn_changesets WHERE session_id = 't9_evict' AND turn_id < 0 ORDER BY turn_id`)).map(r => r[0]);
      await exec(`DELETE FROM turn_changesets WHERE session_id = 't9_evict'`);
      await exec(`DELETE FROM sessions WHERE id = 't9_evict'`);
      R.steps.t13_eviction = {
        posKept: pos.length === 20 && pos[0] === 6 && pos[19] === 25,
        negKept: neg.length === 20 && neg[0] === -25 && neg[19] === -6,
      };
    }

    // ── T14: final cleanup — ⟲ the T2 bubble restores original data ──
    {
      await clickRewind('!UPDATE sample_data SET value = 0 WHERE id = 1');
      const final = await q(`SELECT id, name, category, value FROM sample_data ORDER BY id`);
      const same = baseRows.length === final.length && baseRows.every((r, i) => r.every((v, j) => v === final[i][j]));
      R.steps.t14_restore = { restoredOriginal: same, rows: final.length };
    }

    // ── Final integrity ──────────────────────────────────────────────
    R.integrity = (await q(`PRAGMA integrity_check`))[0][0];
    R.suppressFlags = await q(`SELECT (SELECT value FROM session_context WHERE key='suppress_cascade'), (SELECT value FROM session_context WHERE key='suppress_capture')`);
    R.confirmCount = R.confirms.length;
  } catch (e) {
    R.fatal = e.name + ': ' + e.message;
    R.stack = String(e.stack).slice(0, 1200);
  } finally {
    window.confirm = realConfirm;
  }

  R.ok = !R.fatal && R.integrity === 'ok'
    && R.steps.t1_read?.userInContext === 1 && R.steps.t1_read?.resultInContext === 1
    && R.steps.t1_read?.rowCount === 8 && R.steps.t1_read?.onlyOneAssistantRow && R.steps.t1_read?.domTableRendered
    && R.steps.t2_shared_write?.valNow === 0 && R.steps.t2_shared_write?.userInContext === 1
    && R.steps.t2_shared_write?.changesetTurnNegM
    && R.steps.t3_private_write?.valNow === 42 && R.steps.t3_private_write?.userInContext === 0
    && R.steps.t3_private_write?.resultInContext === 0 && R.steps.t3_private_write?.changesetTurnNegM
    && R.steps.t4_context?.sharedVisible && R.steps.t4_context?.privateHidden
    && R.steps.t5_ddl_create?.ddlLogged && R.steps.t5_ddl_create?.captureTriggersAttached
    && R.steps.t5_ddl_create?.insertChangesets
    && R.steps.t6_ddl_drop?.preImageOk && R.steps.t6_ddl_drop?.tableGone
    && R.steps.t7_rewind_drop?.tableRestored && R.steps.t7_rewind_drop?.triggersReswept
    && R.steps.t7_rewind_drop?.ddlLogConsumed
    && R.steps.t8_kill?.tableGoneMidway && R.steps.t8_kill?.restoredExact
    && R.steps.t9_error?.userRowKept && R.steps.t9_error?.errorRow && R.steps.t9_error?.flagsCleared
    && R.steps.t10_forbidden?.errorRow
    && R.steps.t11_cancel?.row3Intact && R.steps.t11_cancel?.cancelledRow
    && R.steps.t12_cap?.capped && R.steps.t12_cap?.truncatedFlag
    && R.steps.t13_eviction?.posKept && R.steps.t13_eviction?.negKept
    && R.steps.t14_restore?.restoredOriginal
    && R.suppressFlags?.[0][0] === '0' && R.suppressFlags?.[0][1] === '0';
  return R;
}
