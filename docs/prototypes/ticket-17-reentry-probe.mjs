// TEMPORARY PROBE — Ticket 17 re-entry go/no-go (Option A: in-UDF JSPI await).
// Question: while a top-level query is SUSPENDED inside an async UDF (holding the
// T26.1 entryQueue slot), can an event-loop (click-handler-shaped) statement
// re-enter the same wasm connection — classified nested by udfDepth, bypassing
// the queue — and complete? The BUG-008 failure mode is a hang; each re-entry is
// raced against a 10s timeout to detect it.
// Run from the live app page:
//   window.__t17 = {done:false};
//   import('/docs/prototypes/ticket-17-reentry-probe.mjs')
//     .then(m => m.runT17ReentryProbe())
//     .then(r => window.__t17 = {done:true, result:r})
//     .catch(e => window.__t17 = {done:true, error:String(e)});
// then poll window.__t17.
export async function runT17ReentryProbe() {
  const results = {};
  try {
    const agent = window.__agent;
    if (!agent || !agent.ready) return { fatal: 'app not ready (window.__agent missing)' };
    const { sqlite3 } = agent;
    const db = agent.db;
    const { SQLITE_ROW, SQLITE_UTF8 } = await import('/vendor/wa-sqlite-jspi/sqlite-constants.js');

    const q = async (sql) => {
      const rows = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        while (await sqlite3.step(stmt) === SQLITE_ROW) rows.push(sqlite3.row(stmt));
      }
      return rows;
    };
    const race = (p, ms, label) => Promise.race([
      p.then(v => ({ ok: true, v })).catch(e => ({ ok: false, error: String(e) })),
      new Promise(r => setTimeout(() => r({ ok: false, hang: label }), ms)),
    ]);

    // ---- setup: cascade-shaped probe tables + suspending UDF + trigger
    await q('CREATE TABLE IF NOT EXISTS t17_probe_msgs (id INTEGER PRIMARY KEY, role TEXT)');
    await q('CREATE TABLE IF NOT EXISTS t17_probe_data (id INTEGER PRIMARY KEY, v TEXT)');
    await q("INSERT OR REPLACE INTO t17_probe_data VALUES (1, 'before')");

    let resolveSuspend = null;
    let suspendCalls = 0;
    await sqlite3.create_function(db, 't17_suspend', 0, SQLITE_UTF8, null, async (ctx) => {
      suspendCalls++;
      await new Promise((r) => { resolveSuspend = r; });
      sqlite3.result_text(ctx, 'resumed');
    });
    await q(`CREATE TRIGGER IF NOT EXISTS t17_probe_think AFTER INSERT ON t17_probe_msgs BEGIN
      SELECT t17_suspend();
    END`);

    // ---- Phase 1: top-level INSERT fires the trigger -> UDF suspends.
    // The outer query holds the entryQueue slot (independent, udfDepth 0 at first step).
    const outer = q("INSERT INTO t17_probe_msgs (role) VALUES ('user')")
      .then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e) }));
    await new Promise((r) => setTimeout(r, 800));
    results.suspended = suspendCalls === 1;

    // ---- Phase 2: re-entry from the event loop (click-handler shape) — a WRITE.
    // Created while udfDepth > 0 (the suspended UDF keeps the depth) -> classified
    // nested -> bypasses the entryQueue -> re-enters wasm while the fiber is parked.
    results.reentryUpdate = await race(
      q("UPDATE t17_probe_data SET v = 'reentered' WHERE id = 1").then(() => 'updated'),
      10000, 'reentry-update');

    // ---- Phase 3: second sequential re-entry (read) while still suspended.
    if (results.reentryUpdate.ok) {
      results.reentrySelect = await race(
        q("SELECT v FROM t17_probe_data WHERE id = 1"),
        10000, 'reentry-select');
    }

    // ---- Phase 4: resolve the UDF -> the parked outer query must complete.
    if (resolveSuspend) resolveSuspend();
    results.outer = await race(outer, 10000, 'outer-completion');
    results.suspendCalls = suspendCalls;

    // ---- Phase 5: data + integrity, then cleanup.
    results.dataAfter = await q("SELECT v FROM t17_probe_data WHERE id = 1");
    results.integrity = await q('PRAGMA integrity_check');
    await q('DROP TRIGGER IF EXISTS t17_probe_think');
    await q('DROP TABLE IF EXISTS t17_probe_msgs');
    await q('DROP TABLE IF EXISTS t17_probe_data');
    results.cleaned = true;

    results.verdict = (results.suspended && results.reentryUpdate.ok
      && results.reentrySelect?.ok && results.outer.ok) ? 'GO' : 'NO-GO';
    return results;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 800) };
  }
}
