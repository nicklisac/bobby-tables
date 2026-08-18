// Ticket 26.4 — Step 1: investigate the scrapped-branch BUG-008 finding.
//
// The `sql-refactor` branch's BUG_LOG claims: a persistent `CREATE VIEW` over
// `sqlite_master` + a correlated table-valued PRAGMA (`pragma_table_info(m.name)`)
// is "an illegal schema construct" that caused `SQLiteError: database disk image
// is malformed` on DDL/DML mutations inside savepoints. That branch ALSO carried
// a local vendor VFS seal change (never merged) — an alternative cause.
//
// This spec reproduces the scenario on the CURRENT clean build, in a gradient:
//   1. control  — view over sqlite_master only (no table-valued function)
//   2. const    — view over a CONSTANT-argument table-valued PRAGMA
//   3. corr     — view over sqlite_master + NON-CONSTANT correlated table-valued
//                 PRAGMAs (table_info + index_list + foreign_key_list,
//                 json_group_array) — the v_schema_catalog pattern
// then, with the corr view present:
//   4. savepoint DML on messages (INSERT / UPDATE / DELETE)
//   5. savepoint DDL (CREATE TABLE + INSERT + RELEASE)
//   6. read-back + integrity_check + IDB durability
//   7. reload — does the app BOOT cleanly (boot runs DDL + DML) with the view in
//      the schema? Do the view + marker row survive?
//
// Findings are logged as a JSON object. Assertions encode the DESIRED outcome
// (the pattern is legal and safe). A red step = the finding is confirmed on
// this build, and the failure message says exactly which step broke.
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, queryAll, queryValue, idbDump } from '../helpers.mjs';

const V_CONTROL = 't264_probe_master_only';
const V_CONST = 't264_probe_const_pragma';
const V_CORR = 't264_probe_corr_pragma';
const PROBE_TABLE = 't264_probe_tbl';
const MARKER = 'T264 view-legality probe marker';

const CORR_VIEW_SQL = `
CREATE VIEW ${V_CORR} AS
SELECT
  m.name AS table_name,
  m.type AS object_type,
  COALESCE((
    SELECT json_group_array(json_object('cid', p.cid, 'name', p.name, 'type', p.type,
                                         'notnull', p."notnull", 'dflt_value', p.dflt_value, 'pk', p.pk))
    FROM pragma_table_info(m.name) p
  ), '[]') AS columns,
  COALESCE((
    SELECT json_group_array(json_object('seq', i.seq, 'name', i.name, 'unique', i."unique", 'partial', i.partial))
    FROM pragma_index_list(m.name) i
  ), '[]') AS indexes,
  COALESCE((
    SELECT json_group_array(json_object('id', f.id, 'table', f."table", 'from', f."from", 'to', f."to"))
    FROM pragma_foreign_key_list(m.name) f
  ), '[]') AS foreign_keys
FROM sqlite_master m
WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
`;

test.describe('T26.4 step 1 — persistent schema-view legality (scrapped-branch BUG-008)', () => {
  test('view over sqlite_master + table-valued PRAGMA: create, query, savepoint DML/DDL, boot, reload', async ({
    page,
  }) => {
    await bootPage(page);
    const findings = {};
    const step = async (name, fn) => {
      try {
        findings[name] = await fn();
      } catch (e) {
        findings[name] = `FAIL: ${String(e.message || e).split('\n')[0]}`;
      }
    };

    // Defensive cleanup (fresh context per test, but be explicit).
    await queryAll(page, [
      `DROP VIEW IF EXISTS ${V_CONTROL}`,
      `DROP VIEW IF EXISTS ${V_CONST}`,
      `DROP VIEW IF EXISTS ${V_CORR}`,
      `DROP TABLE IF EXISTS ${PROBE_TABLE}`,
      `DELETE FROM messages WHERE content = '${MARKER}'`,
    ].join('; '));

    // ── 1. control: plain view over sqlite_master ──
    await step('control_create', () =>
      queryAll(page, `CREATE VIEW ${V_CONTROL} AS
        SELECT name, type FROM sqlite_master
        WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`));
    await step('control_query', () =>
      queryValue(page, `SELECT COUNT(*) FROM ${V_CONTROL}`));

    // ── 2. constant-argument table-valued PRAGMA ──
    await step('const_create', () =>
      queryAll(page, `CREATE VIEW ${V_CONST} AS
        SELECT cid, name, type, pk FROM pragma_table_info('messages')`));
    await step('const_query', () =>
      queryValue(page, `SELECT COUNT(*) FROM ${V_CONST}`));

    // ── 3. the alleged illegal construct: correlated non-constant PRAGMAs ──
    await step('corr_create', () => queryAll(page, CORR_VIEW_SQL));
    await step('corr_query', async () => {
      const rows = await queryAll(page,
        `SELECT table_name, columns FROM ${V_CORR} WHERE table_name = 'messages'`);
      return rows.length
        ? { rows: rows.length, has_prompt_tokens: String(rows[0][1]).includes('prompt_tokens') }
        : 'no rows for messages';
    });

    // ── 4. savepoint DML on messages, corr view present ──
    // suppress_cascade: a user-role INSERT fires the ReAct cascade (agent_think
    // → ask_llm → HTTP). Unconfigured test context ⇒ 400 ⇒ re-throw ⇒ the
    // INSERT statement fails and the RELEASE never runs. suppress_capture keeps
    // the probe's DML out of turn_changesets (brain left clean).
    await queryAll(page, [
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_capture'`,
    ].join('; '));
    await step('sp_dml_insert', () => queryAll(page, [
      'SAVEPOINT t264_sp',
      `INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', '${MARKER}')`,
      'RELEASE t264_sp',
    ].join('; ')));
    await step('sp_dml_update', () => queryAll(page, [
      'SAVEPOINT t264_sp',
      `UPDATE messages SET content = content || ' +1' WHERE content = '${MARKER}'`,
      'RELEASE t264_sp',
    ].join('; ')));
    await step('sp_dml_delete', () => queryAll(page, [
      'SAVEPOINT t264_sp',
      `DELETE FROM messages WHERE content = '${MARKER} +1'`,
      'RELEASE t264_sp',
    ].join('; ')));
    await step('sp_dml_reinsert', () => queryAll(page, [
      'SAVEPOINT t264_sp',
      `INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', '${MARKER}')`,
      'RELEASE t264_sp',
    ].join('; ')));

    // ── 5. savepoint DDL, corr view present ──
    await step('sp_ddl_create', () => queryAll(page, [
      'SAVEPOINT t264_sp',
      `CREATE TABLE ${PROBE_TABLE} (id INTEGER PRIMARY KEY, v TEXT)`,
      `INSERT INTO ${PROBE_TABLE} VALUES (1, 'x')`,
      'RELEASE t264_sp',
    ].join('; ')));
    await step('sp_ddl_drop', () => queryAll(page, [
      'SAVEPOINT t264_sp',
      `DROP TABLE ${PROBE_TABLE}`,
      'RELEASE t264_sp',
    ].join('; ')));

    // Restore the suppression flags (the app's own try...finally discipline).
    await queryAll(page, [
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_capture'`,
    ].join('; '));

    // ── 6. read-back + integrity + durability ──
    await step('dml_rows', async () =>
      (await queryAll(page,
        `SELECT id, role, substr(content, 1, 40) FROM messages WHERE content LIKE '${MARKER}%' ORDER BY id`)));
    await step('readback', () =>
      queryValue(page, `SELECT COUNT(*) FROM messages WHERE content = '${MARKER}'`));
    await step('integrity', () => queryValue(page, 'PRAGMA integrity_check'));
    await step('corr_query_after_dml', () =>
      queryValue(page, `SELECT COUNT(*) FROM ${V_CORR}`));
    const dump = await idbDump(page, MARKER);
    findings.durability = dump.markerFound ? 'ok' : 'FAIL: marker not in IDB';

    // ── 7. reload: does boot (DDL + DML) run cleanly with the view present? ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    findings.boot_with_view = 'ok';
    await step('boot_integrity', () => queryValue(page, 'PRAGMA integrity_check'));
    await step('view_survives_boot', () =>
      queryValue(page, `SELECT COUNT(*) FROM ${V_CORR}`));
    await step('marker_survives_boot', () =>
      queryValue(page, `SELECT COUNT(*) FROM messages WHERE content = '${MARKER}'`));

    // ── cleanup: leave the brain clean ──
    await queryAll(page, [
      `DROP VIEW IF EXISTS ${V_CONTROL}`,
      `DROP VIEW IF EXISTS ${V_CONST}`,
      `DROP VIEW IF EXISTS ${V_CORR}`,
      `DROP TABLE IF EXISTS ${PROBE_TABLE}`,
      `DELETE FROM messages WHERE content LIKE '${MARKER}%'`,
    ].join('; '));
    findings.cleanup = 'ok';

    console.log('T26.4 view-legality findings:', JSON.stringify(findings, null, 2));

    // Desired outcome: every step ok.
    for (const [k, v] of Object.entries(findings)) {
      expect(String(v), `step "${k}"`).not.toMatch(/^FAIL/);
    }
  });
});
