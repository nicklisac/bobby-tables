// Ticket 3 integration probe — end-to-end verification of the SQL engine.
// Uses the REAL schema.js + rewind.js modules and a fake LLM UDF, on a
// throwaway in-memory DB. The fake LLM's first tool call does REAL DML so it
// runs inside the savepoint during the trigger cascade (like the real agent).
//
// Run in the browser (Vite dev server): import('/docs/prototypes/ticket-3-integration-probe.mjs')
//   .then(m => m.runIntegrationProbe())
// Covers: capture triggers + rewind (A), turn savepoint/rollback/re-insert (B),
// orphan-pair repair (C). Returns { ok: <bool>, parts, integrity }.
export async function runIntegrationProbe() {
  const R = { parts: {} };
  try {
    const { default: ModuleFactory } = await import('/vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs');
    const { Factory } = await import('/vendor/wa-sqlite-jspi/sqlite-api.js');
    const { MemoryVFS } = await import('/vendor/wa-sqlite-jspi/MemoryVFS.js');
    const { SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_UTF8 } = await import('/vendor/wa-sqlite-jspi/sqlite-constants.js');
    const schema = await import('/src/schema.js');
    const rewind = await import('/src/rewind.js');

    const module = await ModuleFactory();
    const sqlite3 = Factory(module);
    const memVfs = await MemoryVFS.create('mem', module);
    sqlite3.vfs_register(memVfs, true);
    const db = await sqlite3.open_v2('t3test.sqlite3', SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE, 'mem');
    await sqlite3.exec(db, 'PRAGMA recursive_triggers = ON;');

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

    // Boot the real schema.
    await sqlite3.exec(db, schema.SCHEMA_SQL);
    await schema.sweepCaptureTriggers(sqlite3, db);

    // Register fake UDFs (no real LLM).
    let llmMode = 'success';
    let llmCalls = 0;
    const dmlToolCall = (label) => JSON.stringify({
      content: '', tool_calls: [{ id: 'c' + llmCalls, type: 'function',
        function: { name: 'execute_sql', arguments: { query: `INSERT INTO sample_data (name, category, value) VALUES ('${label}', 'Test', 5)` } } }],
      prompt_tokens: 1, completion_tokens: 1,
    });
    await sqlite3.create_function(db, 'ask_llm', 2, SQLITE_UTF8, null, async (ctx) => {
      llmCalls++;
      if (llmMode === 'success') {
        sqlite3.result_text(ctx, JSON.stringify({ content: 'done', tool_calls: null, prompt_tokens: 1, completion_tokens: 1 }));
      } else if (llmMode === 'dml-then-throw') {
        if (llmCalls === 1) sqlite3.result_text(ctx, dmlToolCall('CascadeDml'));
        else throw new Error('LLM_TRANSPORT_FAIL');
      } else if (llmMode === 'dml-then-stop') {
        if (llmCalls === 1) sqlite3.result_text(ctx, dmlToolCall('StopDml'));
        else sqlite3.result_text(ctx, JSON.stringify({ content: 'STOPPED_BY_USER', tool_calls: null, prompt_tokens: 0, completion_tokens: 0 }));
      }
    });
    await sqlite3.create_function(db, 'run_dynamic_sql', 1, SQLITE_UTF8, null, async (ctx, args) => {
      const sql = sqlite3.value_text(args[0]);
      const rows = []; let cols = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        cols = sqlite3.column_names(stmt);
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      sqlite3.result_text(ctx, JSON.stringify([{ columns: cols, values: rows }]));
    });
    await sqlite3.create_function(db, 'search_web', 1, SQLITE_UTF8, null, async (ctx) => {
      sqlite3.result_text(ctx, JSON.stringify({ query: 'x', results: [] }));
    });
    await sqlite3.create_function(db, 'fetch_url', 1, SQLITE_UTF8, null, async (ctx) => {
      sqlite3.result_text(ctx, JSON.stringify({ url: 'x', content: 'x' }));
    });

    // ================= PART A: capture triggers + rewind (SQL side) =================
    const A = {};
    A.sampleBefore = await q(`SELECT id, name, value FROM sample_data ORDER BY id`);

    // Synthetic turn 100: DML directly (as the agent would via run_dynamic_sql).
    await schema.setCurrentTurnId(sqlite3, db, 100);
    await exec(`INSERT INTO sample_data (name, category, value) VALUES ('Probe Row', 'Test', 1.5)`);
    await exec(`UPDATE sample_data SET value = 99.9 WHERE id = 1`);
    await exec(`DELETE FROM sample_data WHERE id = 2`);

    A.changesets = await q(`SELECT op, table_name, rowid, row_before IS NOT NULL AS hasBefore, row_after IS NOT NULL AS hasAfter FROM turn_changesets WHERE turn_id = 100 ORDER BY id`);
    A.sampleAfterDml = await q(`SELECT id, name, value FROM sample_data ORDER BY id`);

    const summary = await rewind.getChangesetSummary(sqlite3, db, 'default', 100);
    A.summary = summary;
    const undone = await rewind.rewindToBeforeTurn(sqlite3, db, 'default', 100);
    A.undoneTurns = undone;
    A.sampleAfterRewind = await q(`SELECT id, name, value FROM sample_data ORDER BY id`);
    A.changesetsAfterRewind = (await q(`SELECT COUNT(*) FROM turn_changesets WHERE turn_id >= 100`))[0][0];
    A.markerRow = (await q(`SELECT content FROM messages WHERE role='assistant' AND content LIKE '⟲%' ORDER BY id DESC LIMIT 1`))[0]?.[0] || null;
    A.restored = JSON.stringify(A.sampleAfterRewind) === JSON.stringify(A.sampleBefore);
    R.parts.A = A;

    // ================= PART B: turn lifecycle (savepoint + re-insert) =================
    const B = {};

    // B1: hard error mid-cascade -> rollback erases user row, assistant rows, AND cascade DML.
    llmMode = 'dml-then-throw'; llmCalls = 0;
    await schema.setCurrentTurnId(sqlite3, db, 200);
    await exec(`SAVEPOINT turn_sp`);
    let b1threw = null;
    try {
      await exec(`INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'hard error turn')`);
      B.b1 = 'resolved normally';
    } catch (e) { b1threw = e.message; B.b1 = 'threw: ' + e.message; }
    await exec(`ROLLBACK TO turn_sp; RELEASE turn_sp;`);
    B.b1_threw = b1threw;
    B.b1_llmCalls = llmCalls;
    B.b1_userRowGone = (await q(`SELECT COUNT(*) FROM messages WHERE content='hard error turn'`))[0][0] === 0;
    B.b1_cascadeDmlGone = (await q(`SELECT COUNT(*) FROM sample_data WHERE name='CascadeDml'`))[0][0] === 0;
    B.b1_changesetsGone = (await q(`SELECT COUNT(*) FROM turn_changesets WHERE turn_id = 200`))[0][0] === 0;

    // B2: re-insert dance (suppress_cascade in try/finally).
    await schema.setSuppressCascade(sqlite3, db, true);
    try {
      await exec(`INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'hard error turn')`);
      await exec(`INSERT INTO messages (session_id, role, content) VALUES ('default', 'assistant', '⚠ Turn failed')`);
    } finally {
      await schema.setSuppressCascade(sqlite3, db, false);
    }
    B.b2_userRowPresent = (await q(`SELECT COUNT(*) FROM messages WHERE content='hard error turn'`))[0][0] === 1;
    B.b2_noCascade = (await q(`SELECT COUNT(*) FROM messages WHERE role='assistant' AND content='done'`))[0][0] === 0;
    B.b2_suppressCleared = (await q(`SELECT value FROM session_context WHERE key='suppress_cascade'`))[0][0] === '0';

    // B3: graceful stop -> sentinel, cascade DML kept.
    llmMode = 'dml-then-stop'; llmCalls = 0;
    await schema.setCurrentTurnId(sqlite3, db, 300);
    await exec(`SAVEPOINT turn_sp`);
    let b3threw = null;
    try {
      await exec(`INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'stop me')`);
      B.b3 = 'resolved normally';
    } catch (e) { b3threw = e.message; B.b3 = 'threw: ' + e.message; }
    await exec(`RELEASE turn_sp`);
    B.b3_stopDmlKept = (await q(`SELECT COUNT(*) FROM sample_data WHERE name='StopDml'`))[0][0] === 1;
    B.b3_finalAssistant = (await q(`SELECT content FROM messages WHERE content='STOPPED_BY_USER'`))[0]?.[0] || null;
    B.b3_llmCalls = llmCalls;

    // B4: normal turn -> commits cleanly.
    llmMode = 'success'; llmCalls = 0;
    await schema.setCurrentTurnId(sqlite3, db, 400);
    await exec(`SAVEPOINT turn_sp`);
    let b4threw = null;
    try {
      await exec(`INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', 'normal turn')`);
      B.b4 = 'resolved normally';
    } catch (e) { b4threw = e.message; B.b4 = 'threw: ' + e.message; }
    await exec(`RELEASE turn_sp`);
    B.b4_finalAssistant = (await q(`SELECT COUNT(*) FROM messages WHERE content='done'`))[0][0];

    R.parts.B = B;

    // ================= PART C: boot-time orphan-pair repair =================
    const C = {};
    // assistant row with tool_calls fires execute_tool, which auto-creates the tool row.
    await exec(`INSERT INTO messages (session_id, role, content, tool_calls) VALUES ('default', 'assistant', '', ?)`,
      [JSON.stringify([{ id: 'orphan_1', type: 'function', function: { name: 'execute_sql', arguments: { query: 'SELECT 1' } } }])]);
    // Simulate a crash: the tool row was lost.
    await exec(`DELETE FROM messages WHERE role='tool' AND tool_call_id='orphan_1'`);
    C.orphanBefore = (await q(`SELECT COUNT(*) FROM messages WHERE tool_call_id='orphan_1'`))[0][0];
    await schema.repairOrphanedToolCalls(sqlite3, db, 'default');
    C.orphanAfter = (await q(`SELECT COUNT(*) FROM messages WHERE tool_call_id='orphan_1'`))[0][0];
    C.repairedContent = (await q(`SELECT content FROM messages WHERE tool_call_id='orphan_1'`))[0]?.[0] || null;
    C.suppressClearedAfterRepair = (await q(`SELECT value FROM session_context WHERE key='suppress_cascade'`))[0][0] === '0';
    R.parts.C = C;

    // Overall integrity + pass/fail.
    R.integrity = (await q(`PRAGMA integrity_check`))[0][0];
    R.ok =
      A.restored &&
      A.changesetsAfterRewind === 0 &&
      B.b1_threw === 'LLM_TRANSPORT_FAIL' && B.b1_userRowGone && B.b1_cascadeDmlGone && B.b1_changesetsGone &&
      B.b2_userRowPresent && B.b2_noCascade && B.b2_suppressCleared &&
      B.b3_stopDmlKept && B.b3_finalAssistant === 'STOPPED_BY_USER' &&
      B.b4_finalAssistant === 1 &&
      C.orphanBefore === 0 && C.orphanAfter === 1 && C.suppressClearedAfterRepair &&
      R.integrity === 'ok';
    return R;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 1500) };
  }
}
