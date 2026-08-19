// Ticket 16 probe — in-browser full-text search (fts5).
//
// Verifies, against the live app DB (dev server), that:
//   A. Boot schema: documents + documents_fts + the 3 sync triggers + the
//      unique index exist; both new tools are registered; NO capture triggers
//      are attached to the corpus (T21 boundary); the boot invariant passes.
//   B. Library round-trip: ingest → BM25 search (rank + snippet) → upsert
//      dedup on (source, source_ref) → update + delete index sync → malformed
//      FTS5 query throws a catchable error → list/count.
//   C. A REAL trigger cascade (scripted fake ask_llm) drives the two new
//      tools end-to-end: ingest_document stores a doc, search_documents finds
//      it — proving the tools-table rows, execute_tool CASE arms, and UDF
//      registration all line up.
//   D. T21 boundary through the real agent path: a cascade where the agent
//      calls execute_sql with `INSERT INTO documents …` is REFUSED (protected
//      object) and no row lands.
//
// The auto-ingest side effects (fetch_url / search_web → upsertDocument) are
// the same upsertDocument call exercised in B; they are network-dependent and
// are covered by code review + the AGY pass rather than a flaky network test.
//
// Run from the live app page (dev server):
//   window.__t16 = {done:false};
//   import('/docs/prototypes/ticket-16-fts5-probe.mjs')
//     .then(m => m.runT16Probe())
//     .then(r => window.__t16 = {done:true, result:r})
//     .catch(e => window.__t16 = {done:true, error:String(e)});
// then poll window.__t16. RELOAD THE PAGE AFTERWARDS (restores the real
// ask_llm). The probe cleans up its own documents + session on the way out.
export async function runT16Probe() {
  const R = { facts: {} };
  try {
    const agent = window.__agent;
    if (!agent || !agent.ready) return { fatal: 'app not ready (window.__agent missing)' };
    const { sqlite3, db } = agent;
    const { SQLITE_ROW, SQLITE_UTF8 } = await import('/vendor/wa-sqlite-jspi/sqlite-constants.js');
    const { createSession, setActiveSession, deleteSession, assertProtectedTablesInvariant, isProtectedTable } = await import('/src/schema.js');
    const lib = await import('/src/documents.js');

    const q = async (sql, params = []) => {
      const rows = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        while (await sqlite3.step(stmt) === SQLITE_ROW) rows.push(sqlite3.row(stmt));
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

    // ===================================================================
    // A. Boot schema + T21 boundary (static)
    // ===================================================================
    const objects = (await q(`
      SELECT name, type FROM sqlite_master
      WHERE name IN ('documents','documents_fts','documents_fts_ai','documents_fts_ad','documents_fts_au','idx_documents_source_ref')
      ORDER BY name`)).map(([name, type]) => ({ name, type }));
    const toolNames = (await q(`SELECT name FROM tools ORDER BY name`)).map(r => r[0]);
    const capTriggers = (await q(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'cap_documents%'`)).map(r => r[0]);
    let invariantOk = true, invariantErr = null;
    try { await assertProtectedTablesInvariant(sqlite3, db); } catch (e) { invariantOk = false; invariantErr = e.message; }
    R.facts.schema = {
      objects,
      hasDocuments: objects.some(o => o.name === 'documents' && o.type === 'table'),
      hasFts: objects.some(o => o.name === 'documents_fts' && o.type === 'table'),
      hasSyncTriggers: ['documents_fts_ai', 'documents_fts_ad', 'documents_fts_au'].every(t => objects.some(o => o.name === t && o.type === 'trigger')),
      hasUniqueIndex: objects.some(o => o.name === 'idx_documents_source_ref' && o.type === 'index'),
      tools: toolNames,
      hasSearchTool: toolNames.includes('search_documents'),
      hasIngestTool: toolNames.includes('ingest_document'),
      capTriggers,
      documentsProtected: isProtectedTable('documents'),
      invariantOk, invariantErr,
    };

    // ===================================================================
    // B. Library round-trip
    // ===================================================================
    const marker = 'zebra' + Date.now();
    const b = {};
    const docA = await lib.upsertDocument(sqlite3, db, { source: 'user', title: 'T16 probe A', content: `${marker} quantum entanglement` });
    const docB = await lib.upsertDocument(sqlite3, db, { source: 'web-fetch', sourceRef: 'https://probe.local/sql', title: 'T16 probe B', content: 'sqlite fts5 full text search is fast' });
    b.ingest = { docA, docB };

    const hitA = await lib.searchDocuments(sqlite3, db, marker);
    b.searchMarker = hitA;
    b.searchMarkerOk = hitA.length === 1 && hitA[0].id === docA.id && typeof hitA[0].rank === 'number' && hitA[0].snippet.includes(marker);

    const hitB = await lib.searchDocuments(sqlite3, db, 'fts5 fast');
    b.searchFts = hitB;
    b.searchFtsOk = hitB.length === 1 && hitB[0].id === docB.id;

    // upsert dedup: same (source, source_ref) updates in place
    const docB2 = await lib.upsertDocument(sqlite3, db, { source: 'web-fetch', sourceRef: 'https://probe.local/sql', title: 'T16 probe B v2', content: 'postgres and sqlite both support full text' });
    b.dedup = { docB2, count: await lib.getDocumentCount(sqlite3, db) };
    b.dedupOk = docB2.updated === true && docB2.id === docB.id;
    b.updateSyncOk = (await lib.searchDocuments(sqlite3, db, 'postgres')).some(h => h.id === docB.id)
      && (await lib.searchDocuments(sqlite3, db, 'fts5')).length === 0;

    // delete sync
    const delA = await lib.deleteDocument(sqlite3, db, docA.id);
    b.deleteSync = { delA, gone: (await lib.searchDocuments(sqlite3, db, marker)).length };
    b.deleteSyncOk = delA === true && b.deleteSync.gone === 0;

    // malformed FTS5 query → catchable throw
    let malformed = null;
    try { await lib.searchDocuments(sqlite3, db, 'unbalanced "quote'); malformed = 'NO ERROR (bad)'; }
    catch (e) { malformed = String(e.message || e).slice(0, 60); }
    b.malformed = malformed;
    b.malformedOk = malformed !== 'NO ERROR (bad)';

    // ===================================================================
    // C. Real cascade: ingest_document then search_documents
    // ===================================================================
    const probeSession = await createSession(sqlite3, db, 'T16 Probe');
    await setActiveSession(sqlite3, db, probeSession);
    R.probeSession = probeSession;

    let script = [];
    let callIdx = 0;
    await sqlite3.create_function(db, 'ask_llm', 2, SQLITE_UTF8, null, async (udfCtx) => {
      const i = callIdx++;
      const resp = (typeof script[i] === 'function' ? script[i]() : script[i]) || { content: 'done', tool_calls: null };
      sqlite3.result_text(udfCtx, JSON.stringify(resp));
    });

    const toolCall = (id, name, args) => ({
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
    });

    const runCascade = async (label, steps) => {
      callIdx = 0;
      script = steps;
      const turnPromise = (async () => {
        await exec('SAVEPOINT turn_sp');
        await exec(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`, [probeSession, label]);
        await exec('RELEASE turn_sp');
      })();
      return Promise.race([
        turnPromise.then(() => 'completed').catch(e => 'threw: ' + e.message),
        new Promise(r => setTimeout(() => r('HANG'), 25000)),
      ]);
    };

    const cascadeMarker = 'casc' + Date.now();
    const cTurn = await runCascade('t16 cascade', [
      toolCall('t16-ing', 'ingest_document', { title: 'T16 cascade doc', content: `${cascadeMarker} unique cascade content`, source: 'user' }),
      toolCall('t16-search', 'search_documents', { query: cascadeMarker, limit: 10 }),
      { content: 'cascade done.', tool_calls: null },
    ]);
    R.facts.cascadeTurn = cTurn;

    const cascadeDoc = (await q(`SELECT id, title FROM documents WHERE content LIKE ? ORDER BY id DESC LIMIT 1`, ['%' + cascadeMarker + '%'])).map(r => ({ id: r[0], title: r[1] }));
    const searchToolRow = (await q(
      `SELECT content FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = 't16-search' ORDER BY id DESC LIMIT 1`,
      [probeSession]))[0]?.[0];
    let searchToolParsed = null;
    try { searchToolParsed = JSON.parse(searchToolRow); } catch { /* leave null */ }
    R.facts.cascade = { cascadeDoc, searchToolParsed };
    R.facts.cascadeOk = cTurn === 'completed'
      && cascadeDoc.length === 1 && cascadeDoc[0].title === 'T16 cascade doc'
      && searchToolParsed && searchToolParsed.count === 1
      && searchToolParsed.results && searchToolParsed.results[0].title === 'T16 cascade doc';

    // ===================================================================
    // D. T21 boundary through the real agent path (execute_sql refused)
    // ===================================================================
    const dTurn = await runCascade('t16 boundary', [
      toolCall('t16-hack', 'execute_sql', { query: `INSERT INTO documents (source, title, content) VALUES ('hack', 'should be refused', 'nope')` }),
      { content: 'boundary done.', tool_calls: null },
    ]);
    const hackToolRow = (await q(
      `SELECT content FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = 't16-hack' ORDER BY id DESC LIMIT 1`,
      [probeSession]))[0]?.[0];
    let hackParsed = null;
    try { hackParsed = JSON.parse(hackToolRow); } catch { /* leave null */ }
    const hackRows = (await q(`SELECT COUNT(*) FROM documents WHERE title = 'should be refused'`))[0][0];
    R.facts.boundary = { dTurn, hackParsed, hackRows };
    R.facts.boundaryOk = dTurn === 'completed'
      && hackParsed && typeof hackParsed.error === 'string' && /protected/i.test(hackParsed.error)
      && hackRows === 0;

    R.facts.integrity = (await q('PRAGMA integrity_check'))[0][0];

    // ===================================================================
    // verdict
    // ===================================================================
    const s = R.facts.schema;
    const okSchema = s.hasDocuments && s.hasFts && s.hasSyncTriggers && s.hasUniqueIndex
      && s.hasSearchTool && s.hasIngestTool && s.capTriggers.length === 0
      && s.documentsProtected === true && s.invariantOk === true;
    const okLibrary = b.searchMarkerOk && b.searchFtsOk && b.dedupOk && b.updateSyncOk && b.deleteSyncOk && b.malformedOk;
    R.checks = { okSchema, okLibrary, okCascade: R.facts.cascadeOk, okBoundary: R.facts.boundaryOk };
    R.verdict = (okSchema && okLibrary && R.facts.cascadeOk && R.facts.boundaryOk && R.facts.integrity === 'ok') ? 'GO' : 'NO-GO';

    // ---- cleanup: remove probe docs + session, back to default
    const probeDocs = (await q(`SELECT id FROM documents WHERE content LIKE ? OR content LIKE ? OR title IN ('T16 probe A','T16 probe B v2')`,
      ['%' + marker + '%', '%' + cascadeMarker + '%'])).map(r => r[0]);
    for (const id of probeDocs) await lib.deleteDocument(sqlite3, db, id);
    const defaultItem = document.querySelector(`.session-item[data-session-id="default"]`);
    if (defaultItem) { defaultItem.click(); await sleep(600); }
    await deleteSession(sqlite3, db, probeSession);
    const { populateSessionDropdown } = await import('/src/sessions-ui.js');
    await populateSessionDropdown();
    R.cleaned = (await q(`SELECT COUNT(*) FROM sessions WHERE id = ?`, [probeSession]))[0][0] === 0;
    R.needsReload = true; // fake ask_llm stays registered until reload
    return R;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 800) };
  }
}
