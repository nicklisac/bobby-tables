// TEMPORARY PROBE — Ticket 17 E2E: the real run_dynamic_sql approval flow.
//
// Re-registers a scripted fake `ask_llm` on the live db (the real UDF is a
// boot closure — a page reload restores it), then drives three real cascades
// in a throwaway probe session:
//   A: approve — settleApproval('approved') resumes the parked UDF in place;
//              the write executes in the SAME turn; row 'approved'.
//   B: reject  — settleApproval('rejected'); tool row carries the D4 error;
//              data untouched; row 'rejected'.
//   C: stop    — requestStop() while pending; the UDF records 'rejected',
//              the cascade ends via the stop sentinel; work kept (D6).
// The probe session is LEFT in place (with its 3 approval records) for the
// reload re-render check (runT17RerenderProbe), which also does cleanup.
//
// Run from the live app page:
//   window.__t17e2e = {done:false};
//   import('/docs/prototypes/ticket-17-approval-e2e-probe.mjs')
//     .then(m => m.runT17E2EProbe())
//     .then(r => window.__t17e2e = {done:true, result:r})
//     .catch(e => window.__t17e2e = {done:true, error:String(e)});
// then poll window.__t17e2e. RELOAD THE PAGE AFTERWARDS (restores the real
// ask_llm), then run runT17RerenderProbe.
export async function runT17E2EProbe() {
  const results = { scenarios: {} };
  try {
    const agent = window.__agent;
    if (!agent || !agent.ready) return { fatal: 'app not ready (window.__agent missing)' };
    const { sqlite3, db } = agent;
    const { SQLITE_ROW, SQLITE_UTF8 } = await import('/vendor/wa-sqlite-jspi/sqlite-constants.js');
    const { settleApproval, requestStop, endTurn, isStopRequested } = await import('/src/harness.js');
    const { createSession, setActiveSession, deleteSession } = await import('/src/schema.js');

    const q = async (sql, params = []) => {
      const rows = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        while (await sqlite3.step(stmt) === SQLITE_ROW) rows.push(sqlite3.row(stmt));
      }
      return rows;
    };

    // ---- probe session + data table
    const probeSession = await createSession(sqlite3, db, 'T17 Probe');
    await setActiveSession(sqlite3, db, probeSession);
    await q('CREATE TABLE IF NOT EXISTS t17_e2e_data (id INTEGER PRIMARY KEY, v TEXT)');
    await q("INSERT OR REPLACE INTO t17_e2e_data VALUES (1, 'before')");

    // ---- scripted fake ask_llm (replaces the boot closure until reload)
    let script = [];
    let callIdx = 0;
    await sqlite3.create_function(db, 'ask_llm', 2, SQLITE_UTF8, null, async (ctx) => {
      const i = callIdx++;
      const resp = (typeof script[i] === 'function' ? script[i]() : script[i])
        || { content: 'done', tool_calls: null };
      sqlite3.result_text(ctx, JSON.stringify(resp));
    });

    // ---- event capture (the app's own listener runs in parallel — the real
    // UI widget renders too; this reader is the probe's eyes)
    const reader = agent.eventStream.getStream().getReader();
    const waitForEvent = (type, timeoutMs = 20000) => new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeoutMs);
      (async () => {
        try {
          for (;;) {
            const { value } = await reader.read();
            if (value && value.type === type) { clearTimeout(watchdog); resolve(value); return; }
          }
        } catch (e) { clearTimeout(watchdog); reject(e); }
      })();
    });

    const writeSql = (tag) => `UPDATE t17_e2e_data SET v = '${tag}' WHERE id = 1`;
    const toolCallResp = (id, sql) => ({
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'execute_sql', arguments: { query: sql } } }],
    });

    // One scenario: open the turn savepoint, fire the cascade (detached — it
    // suspends inside run_dynamic_sql), wait for approval_request, apply the
    // decision, await cascade completion + RELEASE.
    const runScenario = async (name, userText, decide) => {
      callIdx = 0;
      const turnPromise = (async () => {
        await sqlite3.exec(db, 'SAVEPOINT turn_sp');
        for await (const stmt of sqlite3.statements(db, `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`)) {
          sqlite3.bind_collection(stmt, [probeSession, userText]);
          await sqlite3.step(stmt);
        }
        await sqlite3.exec(db, 'RELEASE turn_sp');
      })();
      let decision;
      try {
        const ev = await waitForEvent('approval_request');
        decision = await decide(ev);
      } catch (e) {
        // Unstick the page (resolves any pending approval as 'stopped').
        requestStop();
        try { await turnPromise; } catch { /* cascade already ended */ }
        return { error: String(e) };
      }
      const turnRes = await Promise.race([
        turnPromise.then(() => 'completed').catch(e => 'threw: ' + e.message),
        new Promise(r => setTimeout(() => r('HANG'), 20000)),
      ]);
      if (turnRes === 'HANG') { requestStop(); }
      return { turn: turnRes, decision };
    };

    const approvals = async () => (await q(
      `SELECT id, turn_id, payload, status, decided_at FROM tool_approvals WHERE session_id = ? ORDER BY id ASC`,
      [probeSession]
    )).map(([id, turnId, payload, status, decidedAt]) => ({ approvalId: id, turnId, payload, status, decidedAt }));
    const dataV = async () => (await q('SELECT v FROM t17_e2e_data WHERE id = 1'))[0][0];
    const sessionMsgs = () => q(
      `SELECT role, content, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC`, [probeSession]);

    // ---- Scenario A: approve
    script = [
      toolCallResp('t17a1', writeSql('approved-write')),
      { content: 'Write approved and executed.', tool_calls: null },
    ];
    results.scenarios.A = await runScenario('A', 'probe turn A (approve)',
      async (ev) => { await settleApproval(sqlite3, db, ev.approvalId, 'approved'); return 'approved'; });
    {
      const appr = (await approvals())[0] || {};
      const msgs = await sessionMsgs();
      const toolRow = msgs.find(([role]) => role === 'tool');
      results.A = {
        data: await dataV(),
        approval: appr,
        roles: msgs.map(([r]) => r),
        toolContent: toolRow ? toolRow[1] : null,
      };
    }

    // ---- Scenario B: reject
    script = [
      toolCallResp('t17b1', writeSql('rejected-write')),
      { content: 'Write rejected; noted.', tool_calls: null },
    ];
    results.scenarios.B = await runScenario('B', 'probe turn B (reject)',
      async (ev) => { await settleApproval(sqlite3, db, ev.approvalId, 'rejected'); return 'rejected'; });
    {
      const appr = (await approvals())[1] || {};
      const msgs = await sessionMsgs();
      const toolRow = msgs.filter(([role]) => role === 'tool')[1];
      results.B = {
        data: await dataV(),
        approval: appr,
        roles: msgs.map(([r]) => r).slice(4),
        toolContent: toolRow ? toolRow[1] : null,
      };
    }

    // ---- Scenario C: stop while pending (last — it leaves stopRequested set)
    script = [
      toolCallResp('t17c1', writeSql('stopped-write')),
      () => isStopRequested()
        ? { content: '⏹ Turn stopped by user.', tool_calls: null }
        : { content: 'done', tool_calls: null },
    ];
    results.scenarios.C = await runScenario('C', 'probe turn C (stop)',
      async () => { requestStop(); return 'stopped'; });
    endTurn();
    {
      const appr = (await approvals())[2] || {};
      const msgs = await sessionMsgs();
      results.C = {
        data: await dataV(),
        approval: appr,
        roles: msgs.map(([r]) => r).slice(8),
        lastContent: msgs.length ? msgs[msgs.length - 1][1] : null,
      };
    }

    results.probeSession = probeSession;
    results.approvalCount = (await approvals()).length;
    results.integrity = (await q('PRAGMA integrity_check'))[0][0];
    // Note: B/C's data assertion is 'approved-write' — A's approved write
    // persists; B's and C's writes were refused, so the value is unchanged.
    results.verdict =
      results.A?.approval?.status === 'approved' && results.A?.data === 'approved-write'
      && results.B?.approval?.status === 'rejected' && results.B?.data === 'approved-write'
      && results.C?.approval?.status === 'rejected' && results.C?.data === 'approved-write'
      && results.C?.lastContent === '⏹ Turn stopped by user.'
      && results.integrity === 'ok' ? 'GO' : 'NO-GO';
    return results;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 800) };
  }
}

// ── Phase 2 (run AFTER a page reload): boot re-render + cleanup ──────
export async function runT17RerenderProbe() {
  const results = {};
  try {
    const agent = window.__agent;
    if (!agent || !agent.ready) return { fatal: 'app not ready (window.__agent missing)' };
    const { sqlite3, db } = agent;
    const { SQLITE_ROW } = await import('/src/utils.js');
    const { deleteSession } = await import('/src/schema.js');
    const q = async (sql, params = []) => {
      const rows = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        while (await sqlite3.step(stmt) === SQLITE_ROW) rows.push(sqlite3.row(stmt));
      }
      return rows;
    };

    // Boot always activates 'default' (main.js), so switch to the probe
    // session via the app's REAL switch path — a click on the session item
    // (updates main.js's JS state + DB + renderMessages).
    const probeSessions = await q(`SELECT id FROM sessions WHERE name = 'T17 Probe'`);
    if (!probeSessions.length) return { fatal: 'no probe session found' };
    const probeSessionId = probeSessions[0][0];
    const item = document.querySelector(`.session-item[data-session-id="${probeSessionId}"]`);
    if (!item) return { fatal: 'probe session not in the session list' };
    item.click();
    await new Promise(r => setTimeout(r, 1500)); // async switch + render
    const widgets = Array.from(document.querySelectorAll('.approval-widget'));
    results.widgetCount = widgets.length;
    results.widgets = widgets.map(w => ({
      decided: w.dataset.decided || null,
      hasButtons: !!w.querySelector('.approval-btn'),
      label: w.querySelector('.message-label span')?.textContent || null,
      sql: (w.querySelector('.approval-sql code')?.textContent || '').slice(0, 60),
    }));

    // Cleanup: drop the probe session (cascades its approvals/messages) and
    // the probe table; restore the default session via its real switch path.
    // The fake ask_llm is gone (this probe runs post-reload — the real UDF
    // is registered).
    for (const [sid] of probeSessions) {
      await deleteSession(sqlite3, db, sid);
    }
    await q('DROP TABLE IF EXISTS t17_e2e_data');
    const defaultItem = document.querySelector(`.session-item[data-session-id="default"]`);
    if (defaultItem) {
      defaultItem.click();
      await new Promise(r => setTimeout(r, 1000));
    }
    results.cleaned = (await q(`SELECT COUNT(*) FROM sessions WHERE name = 'T17 Probe'`))[0][0] === 0;
    results.approvalsLeft = (await q(`SELECT COUNT(*) FROM tool_approvals`))[0][0];
    return results;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 800) };
  }
}
