// TEMPORARY PROBE — Ticket 3 turn-lifecycle verification on the real IDBBatchAtomicVFS.
// Delete after use.
export async function runProbe() {
  const results = {};
  try {
    const { default: ModuleFactory } = await import('/vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs');
    const { Factory } = await import('/vendor/wa-sqlite-jspi/sqlite-api.js');
    const { IDBBatchAtomicVFS } = await import('/vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js');
    const { SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_UTF8, SQLITE_ROW } = await import('/vendor/wa-sqlite-jspi/sqlite-constants.js');

    const module = await ModuleFactory();
    const sqlite3 = Factory(module);
    const vfs = await IDBBatchAtomicVFS.create('probeT3idb', module);
    sqlite3.vfs_register(vfs, true);
    const db = await sqlite3.open_v2('probeT3.sqlite3', SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE, 'probeT3idb');
    await sqlite3.exec(db, 'PRAGMA recursive_triggers = ON;');

    const q = async (d, sql) => {
      const rows = [];
      for await (const stmt of sqlite3.statements(d, sql)) {
        while (await sqlite3.step(stmt) === SQLITE_ROW) rows.push(sqlite3.row(stmt));
      }
      return rows;
    };

    await sqlite3.exec(db, 'CREATE TABLE msgs (id INTEGER PRIMARY KEY, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT)');
    await sqlite3.exec(db, 'CREATE TABLE data_tbl (id INTEGER PRIMARY KEY, v TEXT)');
    await sqlite3.exec(db, "INSERT INTO data_tbl VALUES (1, 'original')");

    let llmCalls = 0;
    let mode = 'throw-on-second';
    await sqlite3.create_function(db, 'fake_llm', 0, SQLITE_UTF8, null, async (ctx) => {
      llmCalls++;
      if (mode === 'throw-on-second') {
        if (llmCalls === 1) {
          sqlite3.result_text(ctx, JSON.stringify({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: {} } }] }));
        } else {
          throw new Error('LLM_TRANSPORT_FAIL');
        }
      } else if (mode === 'stop-on-second') {
        if (llmCalls === 1) {
          sqlite3.result_text(ctx, JSON.stringify({ content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'noop', arguments: {} } }] }));
        } else {
          sqlite3.result_text(ctx, JSON.stringify({ content: 'STOPPED_BY_USER', tool_calls: null }));
        }
      } else {
        sqlite3.result_text(ctx, JSON.stringify({ content: 'done', tool_calls: null }));
      }
    });
    await sqlite3.create_function(db, 'noop_tool', 0, SQLITE_UTF8, null, async (ctx) => {
      sqlite3.result_text(ctx, JSON.stringify({ ok: true }));
    });
    await sqlite3.exec(db, `CREATE TRIGGER think AFTER INSERT ON msgs WHEN NEW.role IN ('user','tool') BEGIN
      INSERT INTO msgs (role, content, tool_calls)
      SELECT 'assistant', json_extract(r, '$.content'), json_extract(r, '$.tool_calls')
      FROM (SELECT fake_llm() AS r);
    END`);
    await sqlite3.exec(db, `CREATE TRIGGER act AFTER INSERT ON msgs WHEN NEW.role = 'assistant' AND NEW.tool_calls IS NOT NULL BEGIN
      INSERT INTO msgs (role, content, tool_call_id)
      SELECT 'tool', noop_tool(), json_extract(NEW.tool_calls, '$[0].id');
    END`);
    await sqlite3.exec(db, `CREATE TRIGGER do_dml AFTER INSERT ON msgs WHEN NEW.role = 'tool' BEGIN
      UPDATE data_tbl SET v = 'mutated-by-turn' WHERE id = 1;
    END`);

    // ---- Phase 1: hard error inside savepoint -> ROLLBACK TO + RELEASE
    mode = 'throw-on-second';
    llmCalls = 0;
    await sqlite3.exec(db, 'SAVEPOINT turn_sp');
    let threw = null;
    try {
      await sqlite3.exec(db, "INSERT INTO msgs (role, content) VALUES ('user', 'do the thing')");
    } catch (e) { threw = e.message; }
    results.p1_threw = threw;
    results.p1_llmCalls = llmCalls;
    results.p1_msgsInsideSp = await q(db, 'SELECT role FROM msgs ORDER BY id');
    results.p1_dataInsideSp = await q(db, 'SELECT v FROM data_tbl');
    await sqlite3.exec(db, 'ROLLBACK TO turn_sp; RELEASE turn_sp;');
    results.p1_msgsAfterRollback = await q(db, 'SELECT role FROM msgs ORDER BY id');
    results.p1_dataAfterRollback = await q(db, 'SELECT v FROM data_tbl');

    // ---- Phase 2: graceful stop inside savepoint -> RELEASE (work kept)
    mode = 'stop-on-second';
    llmCalls = 0;
    await sqlite3.exec(db, 'SAVEPOINT turn_sp');
    try {
      await sqlite3.exec(db, "INSERT INTO msgs (role, content) VALUES ('user', 'stop me')");
      results.p2 = 'resolved normally';
    } catch (e) { results.p2 = 'threw: ' + e.message; }
    await sqlite3.exec(db, 'RELEASE turn_sp');
    results.p2_msgs = await q(db, 'SELECT role, substr(content,1,20) FROM msgs ORDER BY id');
    results.p2_data = await q(db, 'SELECT v FROM data_tbl');

    // ---- Phase 3: normal successful turn
    mode = 'success';
    llmCalls = 0;
    await sqlite3.exec(db, 'SAVEPOINT turn_sp');
    try {
      await sqlite3.exec(db, "INSERT INTO msgs (role, content) VALUES ('user', 'normal turn')");
      results.p3 = 'resolved normally';
    } catch (e) { results.p3 = 'threw: ' + e.message; }
    await sqlite3.exec(db, 'RELEASE turn_sp');
    results.p3_msgs = await q(db, 'SELECT role, substr(content,1,20) FROM msgs ORDER BY id');

    // ---- Phase 4: close + reopen (VFS consistency) + integrity
    await sqlite3.close(db);
    const db2 = await sqlite3.open_v2('probeT3.sqlite3', SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE, 'probeT3idb');
    results.p4_msgsAfterReopen = await q(db2, 'SELECT role, substr(content,1,20) FROM msgs ORDER BY id');
    results.p4_dataAfterReopen = await q(db2, 'SELECT v FROM data_tbl');
    results.p4_integrity = await q(db2, 'PRAGMA integrity_check');
    await sqlite3.close(db2);
    indexedDB.deleteDatabase('probeT3idb');

    return results;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 800) };
  }
}
