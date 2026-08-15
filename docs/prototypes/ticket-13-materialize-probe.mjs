// Ticket 13 materialization probe — end-to-end verification of the
// Tool-Output Materialization Engine against the LIVE agent DB and UDFs.
//
// Run in the browser console (Vite dev server :5174):
//   import('/docs/prototypes/ticket-13-materialize-probe.mjs').then(m => m.runT13Probe())
//
// Returns { ok, steps: {...}, summary: '...' }.

import {
  detectShapeAndExtractRows,
  inferJsonValueType,
  promoteType,
  inferSchemaFromRows,
  validateTableName,
  materializeToolResult,
} from '../../src/materialize.js';
import { rewindToBefore } from '../../src/rewind.js';

export async function runT13Probe() {
  const R = { steps: {} };
  const { sqlite3, db } = window.__agent;
  const SESSION = 'default';

  const q = async (sql, params = []) => {
    const rows = [];
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params);
      while (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) rows.push(sqlite3.row(stmt));
    }
    return rows;
  };

  const exec = async (sql, params = []) => {
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params);
      await sqlite3.step(stmt);
    }
  };

  console.log('🚀 Starting Ticket 13 Materialization Probe...');

  // ─────────────────────────────────────────────────────────────────────
  // Step 1: Shape Detection Unit Checks
  // ─────────────────────────────────────────────────────────────────────
  {
    // (0) Columnar reject
    const colShape1 = [{ columns: ['id', 'name'], values: [[1, 'Alice']] }];
    const resCol1 = detectShapeAndExtractRows(colShape1);
    const colShape2 = { columns: ['id', 'name'], values: [[1, 'Alice']] };
    const resCol2 = detectShapeAndExtractRows(colShape2);

    // (a) Array of objects
    const arrObjs = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
    const resArr = detectShapeAndExtractRows(arrObjs);

    // (b) Single array property (search_web shape)
    const searchShape = { query: 'test', results: [{ title: 'T1', url: 'U1' }, { title: 'T2', url: 'U2' }] };
    const resSearch = detectShapeAndExtractRows(searchShape);

    // (b-ambiguous) Multiple array properties
    const multiArr = { items1: [{ a: 1 }], items2: [{ b: 2 }] };
    const resMulti = detectShapeAndExtractRows(multiArr);

    // (c) Plain object without array property (fetch_url shape)
    const fetchShape = { url: 'https://example.com', title: 'Example', content: 'Hello' };
    const resFetch = detectShapeAndExtractRows(fetchShape);

    // Invalid shapes
    const emptyArr = [];
    const scalarArr = [1, 2, 3];
    const errEnv = { error: 'Upstream tool failure' };

    const ok = (
      resCol1.error && resCol1.error.includes('execute_sql columnar format') &&
      resCol2.error && resCol2.error.includes('execute_sql columnar format') &&
      resArr.rows && resArr.rows.length === 2 &&
      resSearch.rows && resSearch.rows.length === 2 &&
      resMulti.error && resMulti.error.includes('Ambiguous') &&
      resFetch.rows && resFetch.rows.length === 1 &&
      detectShapeAndExtractRows(emptyArr).error &&
      detectShapeAndExtractRows(scalarArr).error &&
      detectShapeAndExtractRows(errEnv).error
    );

    R.steps.shape_detection = {
      ok: Boolean(ok),
      columnar_rejected: Boolean(resCol1.error && resCol2.error),
      array_extracted: resArr.rows?.length === 2,
      search_extracted: resSearch.rows?.length === 2,
      ambiguous_rejected: Boolean(resMulti.error),
      fetch_single_row: resFetch.rows?.length === 1,
    };
    console.log('Step 1 (Shape Detection):', R.steps.shape_detection.ok ? '✅ PASS' : '❌ FAIL');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: Schema Inference & Type Promotion Unit Checks
  // ─────────────────────────────────────────────────────────────────────
  {
    const testRows = [
      { id: 1, score: 95.5, active: true, tag: 'gold', meta: { level: 2 }, note: null, SAME: 'A' },
      { id: 2, score: 80,   active: false, tag: 123,   meta: ['x', 'y'], note: 'present', same: 'B' },
      { id: 3, score: null, active: null,  tag: 'bronze', extra: 'new_col' },
    ];

    const schemaRes = inferSchemaFromRows(testRows);
    const cols = schemaRes.columns || [];
    const colMap = Object.fromEntries(cols.map(c => [c.name, c.type]));

    const ok = (
      colMap.id === 'INTEGER' &&
      colMap.score === 'REAL' &&
      colMap.active === 'INTEGER' &&
      colMap.tag === 'TEXT' && // promoted INTEGER -> TEXT
      colMap.meta === 'TEXT' && // stringified JSON
      colMap.note === 'TEXT' &&
      colMap.SAME !== undefined &&
      colMap.SAME_2 !== undefined && // deduplicated case-insensitive collision
      colMap.extra === 'TEXT'
    );

    R.steps.schema_inference = {
      ok: Boolean(ok),
      columns: colMap,
      total_columns: cols.length,
    };
    console.log('Step 2 (Schema Inference):', R.steps.schema_inference.ok ? '✅ PASS' : '❌ FAIL', colMap);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 3: Name Validation & Collisions
  // ─────────────────────────────────────────────────────────────────────
  {
    const valid1 = validateTableName('my_table_1');
    const inv1 = validateTableName('123bad');
    const inv2 = validateTableName('my-table!');
    const prot1 = validateTableName('messages');
    const prot2 = validateTableName('sqlite_stat1');

    const ok = (
      valid1.valid &&
      !inv1.valid &&
      !inv2.valid &&
      !prot1.valid &&
      !prot2.valid
    );

    R.steps.name_validation = {
      ok: Boolean(ok),
      valid: valid1.valid,
      invalid_start_digit: !inv1.valid,
      invalid_chars: !inv2.valid,
      protected_internal: !prot1.valid,
      protected_sqlite: !prot2.valid,
    };
    console.log('Step 3 (Name Validation):', R.steps.name_validation.ok ? '✅ PASS' : '❌ FAIL');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: End-to-End Materialization of search_web Result
  // ─────────────────────────────────────────────────────────────────────
  {
    const toolCallId = `call_probe_search_${Date.now()}`;
    const searchPayload = {
      query: 'climate change renewable energy',
      results: [
        { title: 'Solar Tech 2026', url: 'https://solar.example.com', rank: 1, rating: 4.8, active: true },
        { title: 'Wind Power Future', url: 'https://wind.example.com', rank: 2, rating: 4.5, active: true },
        { title: 'Grid Storage Innovations', url: 'https://grid.example.com', rank: 3, rating: 4.9, active: false },
      ],
    };

    // Insert fake tool message into messages table
    await exec(
      `INSERT INTO messages (session_id, role, content, tool_call_id) VALUES (?, 'tool', ?, ?)`,
      [SESSION, JSON.stringify(searchPayload), toolCallId]
    );

    // Call materializeToolResult
    const tableName = 'probe_search_results';
    await exec(`DROP TABLE IF EXISTS ${tableName}`);

    const matRes = await materializeToolResult(sqlite3, db, {
      tableName,
      toolCallId,
      sessionId: SESSION,
      turnId: 901,
    });

    // Verify table in sqlite_master
    const masterRows = await q(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [tableName]);
    // Verify row count
    const countRows = await q(`SELECT COUNT(*) FROM ${tableName}`);
    // Verify contents
    const rows = await q(`SELECT title, rank, rating, active FROM ${tableName} ORDER BY rank ASC`);
    // Verify capture triggers
    const triggers = await q(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, [tableName]);
    // Verify DDL log
    const ddlRows = await q(`SELECT turn_id, table_name, ddl_sql FROM turn_ddl_log WHERE table_name = ?`, [tableName]);

    const ok = (
      matRes.materialized === true &&
      matRes.row_count === 3 &&
      masterRows.length === 1 &&
      countRows[0][0] === 3 &&
      rows.length === 3 &&
      rows[0][0] === 'Solar Tech 2026' &&
      rows[0][1] === 1 &&
      rows[0][2] === 4.8 &&
      rows[0][3] === 1 && // boolean true -> 1
      triggers.length === 3 &&
      ddlRows.length >= 1
    );

    R.steps.materialize_search = {
      ok: Boolean(ok),
      envelope: matRes,
      db_count: countRows[0]?.[0],
      triggers_attached: triggers.map(t => t[0]),
      ddl_logged: ddlRows.length > 0,
    };
    console.log('Step 4 (Materialize Search Result):', R.steps.materialize_search.ok ? '✅ PASS' : '❌ FAIL');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 5: Collision Refusal Check
  // ─────────────────────────────────────────────────────────────────────
  {
    // Try to materialize into existing table 'probe_search_results'
    const collRes = await materializeToolResult(sqlite3, db, {
      tableName: 'probe_search_results',
      sessionId: SESSION,
    });

    const ok = collRes.error && collRes.error.includes('already exists');
    R.steps.collision_refusal = {
      ok: Boolean(ok),
      error: collRes.error,
    };
    console.log('Step 5 (Collision Refusal):', R.steps.collision_refusal.ok ? '✅ PASS' : '❌ FAIL', collRes.error);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 6: Omitted tool_call_id (Most Recent Tool Result) Resolution
  // ─────────────────────────────────────────────────────────────────────
  {
    const fetchPayload = {
      url: 'https://news.ycombinator.com',
      title: 'Hacker News',
      status: 200,
      content: 'Top stories in technology and startups...',
      truncated: false,
    };

    // Insert latest tool row
    const latestToolCallId = `call_probe_fetch_${Date.now()}`;
    await exec(
      `INSERT INTO messages (session_id, role, content, tool_call_id) VALUES (?, 'tool', ?, ?)`,
      [SESSION, JSON.stringify(fetchPayload), latestToolCallId]
    );

    const tableName = 'probe_hn_preview';
    await exec(`DROP TABLE IF EXISTS ${tableName}`);

    // Call materialize WITHOUT tool_call_id
    const matRes = await materializeToolResult(sqlite3, db, {
      tableName,
      sessionId: SESSION,
      turnId: 902,
    });

    const countRows = await q(`SELECT COUNT(*) FROM ${tableName}`);
    const dataRows = await q(`SELECT url, status, title FROM ${tableName}`);

    const ok = (
      matRes.materialized === true &&
      matRes.source?.tool_call_id === latestToolCallId &&
      matRes.row_count === 1 &&
      countRows[0][0] === 1 &&
      dataRows[0][0] === 'https://news.ycombinator.com' &&
      dataRows[0][1] === 200
    );

    R.steps.omitted_tool_call_id = {
      ok: Boolean(ok),
      resolved_tool_call_id: matRes.source?.tool_call_id,
      expected_tool_call_id: latestToolCallId,
      row_count: countRows[0]?.[0],
    };
    console.log('Step 6 (Omitted tool_call_id Resolution):', R.steps.omitted_tool_call_id.ok ? '✅ PASS' : '❌ FAIL');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 7: Rolling State Rewind of Materialized Table
  // ─────────────────────────────────────────────────────────────────────
  {
    const turnUserMsgId = 99999;
    const turnTable = 'probe_rewind_target';
    await exec(`DROP TABLE IF EXISTS ${turnTable}`);

    // Create user message marking turn start
    await exec(
      `INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', 'Materialize something')`,
      [turnUserMsgId, SESSION]
    );
    await exec(`UPDATE session_context SET value = ? WHERE key = 'current_turn_id'`, [String(turnUserMsgId)]);

    // Materialize table stamped with turnUserMsgId
    const matRes = await materializeToolResult(sqlite3, db, {
      tableName: turnTable,
      sessionId: SESSION,
      turnId: turnUserMsgId,
      rawContent: [{ colA: 'Alpha', colB: 100 }, { colA: 'Beta', colB: 200 }],
    });

    // Check table exists
    const beforeCheck = await q(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, [turnTable]);

    // Rewind to before turnUserMsgId
    await rewindToBefore(turnUserMsgId);

    // Check table dropped by DDL undo
    const afterCheck = await q(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, [turnTable]);

    const ok = (
      matRes.materialized === true &&
      beforeCheck[0][0] === 1 &&
      afterCheck[0][0] === 0
    );

    R.steps.rewind_undo = {
      ok: Boolean(ok),
      table_existed_before: beforeCheck[0][0] === 1,
      table_dropped_after_rewind: afterCheck[0][0] === 0,
    };
    console.log('Step 7 (Rewind Undo DDL):', R.steps.rewind_undo.ok ? '✅ PASS' : '❌ FAIL');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 8: Trigger Cascade Execution via UDF
  // ─────────────────────────────────────────────────────────────────────
  {
    // Test the UDF registered on wa-sqlite
    const cascadeTable = 'probe_udf_materialize';
    await exec(`DROP TABLE IF EXISTS ${cascadeTable}`);

    const res = await q(`SELECT materialize(?, ?)`, [cascadeTable, null]);
    const parsed = JSON.parse(res[0][0]);

    const checkTable = await q(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, [cascadeTable]);

    const ok = (
      parsed.materialized === true &&
      parsed.table === cascadeTable &&
      checkTable[0][0] === 1
    );

    R.steps.udf_cascade = {
      ok: Boolean(ok),
      udf_output: parsed,
      table_created: checkTable[0][0] === 1,
    };
    console.log('Step 8 (UDF Execution):', R.steps.udf_cascade.ok ? '✅ PASS' : '❌ FAIL');

    // Clean up probe tables and test messages
    await exec(`DROP TABLE IF EXISTS probe_search_results`);
    await exec(`DROP TABLE IF EXISTS probe_hn_preview`);
    await exec(`DROP TABLE IF EXISTS probe_udf_materialize`);
    await exec(`DELETE FROM messages WHERE tool_call_id LIKE 'call_probe_%'`);
    await exec(`DELETE FROM messages WHERE id = 99999`);
  }

  const allPassed = Object.values(R.steps).every(s => s.ok);
  R.ok = allPassed;
  R.summary = allPassed ? 'All Ticket 13 materialization checks PASSED' : 'Some checks FAILED';
  console.log('🏁 Ticket 13 Materialization Probe Finished:', R.summary);
  return R;
}
