// Ticket 26.5 sub1 follow-up — system-object guards at the SQL-execution
// boundary.
//
// The explorer UI hides the drop action for system views and dropDatabaseObject
// now throws for them, but the two SQL-execution paths (the agent's execute_sql
// → run_dynamic_sql UDF, and the direct console → scratchpad write gate) only
// guarded internal TABLES (isProtectedTable), not app system views. So a direct
// `DROP VIEW v_active_context` / `CREATE VIEW v_active_context AS …` was NOT
// rejected. This spec is the anti-bypass gate:
//   1. execute_sql must reject DDL + DML on system views (and the object
//      survives — not just "rejected", actually intact).
//   2. `CREATE OR REPLACE` must be caught by the target extractor (it was a
//      bypass for even the table guard).
//   3. the scratchpad gate (classifyStatement) must reject the same, and still
//      allow reads + user objects (non-vacuous).
import { test, expect } from '@playwright/test';
import { bootPage, queryAll, queryValue } from '../helpers.mjs';

// Drive the agent's execute_sql path directly: run_dynamic_sql is the UDF the
// execute_tool trigger calls, and it runs the guard BEFORE executing. Rejected
// statements return {error} before any DDL/DML and before the permission popup,
// so no dialog handling is needed for the rejection cases.
const runSql = (page, sql) =>
  queryAll(page, 'SELECT run_dynamic_sql(?)', [sql]).then((rows) => JSON.parse(rows[0][0]));

test.describe('T26.5 — system-object guards at the SQL-execution boundary', () => {
  test('execute_sql rejects DDL + DML on a system view; the view survives intact', async ({ page }) => {
    await bootPage(page);

    // DROP VIEW — rejected, view still present.
    const drop = await runSql(page, 'DROP VIEW v_active_context');
    expect(drop.error, 'DROP VIEW on a system view must be rejected').toMatch(/rejected/i);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM sqlite_master WHERE type='view' AND name='v_active_context'`)).toBe(1);

    // CREATE VIEW (shadow/replace) — rejected, real definition unchanged.
    const create = await runSql(page, 'CREATE VIEW v_active_context AS SELECT 1 AS t265_shadow_v');
    expect(create.error, 'CREATE VIEW shadowing a system view must be rejected').toMatch(/rejected/i);
    const viewSql = await queryValue(page,
      `SELECT sql FROM sqlite_master WHERE type='view' AND name='v_active_context'`);
    expect(viewSql, 'system view definition must be unchanged (not shadowed)').not.toContain('t265_shadow_v');

    // DML (DELETE) — rejected by the guard, not just incidentally "not updatable".
    const del = await runSql(page, 'DELETE FROM v_active_context');
    expect(del.error, 'DML on a system view must be rejected').toMatch(/rejected/i);
  });

  test('execute_sql rejects CREATE OR REPLACE on a system view and a protected table', async ({ page }) => {
    await bootPage(page);

    const createView = await runSql(page, 'CREATE OR REPLACE VIEW v_active_context AS SELECT 1 AS t265_shadow_v2');
    expect(createView.error, 'CREATE OR REPLACE VIEW on a system view must be rejected').toMatch(/rejected/i);
    const viewSql = await queryValue(page,
      `SELECT sql FROM sqlite_master WHERE type='view' AND name='v_active_context'`);
    expect(viewSql, 'system view must not be shadowed via CREATE OR REPLACE').not.toContain('t265_shadow_v2');

    // The same phrasing must also catch a protected TABLE (the original bypass).
    const createTable = await runSql(page, 'CREATE OR REPLACE TABLE messages (id INTEGER)');
    expect(createTable.error, 'CREATE OR REPLACE TABLE on a protected table must be rejected').toMatch(/rejected/i);
    const msgCols = await queryAll(page, `PRAGMA table_info('messages')`);
    expect(msgCols.length, 'messages table must be intact').toBeGreaterThan(3);
  });

  test('scratchpad gate (classifyStatement) rejects system views; allows reads + user objects', async ({ page }) => {
    await bootPage(page);
    const r = await page.evaluate(async () => {
      const { classifyStatement } = await import('/src/scratchpad.js');
      const pick = (sql) => {
        const c = classifyStatement(sql);
        return { kind: c.kind, reason: c.reason || null };
      };
      return {
        dropSysView: pick('DROP VIEW v_active_context'),
        createSysView: pick('CREATE OR REPLACE VIEW v_active_context AS SELECT 1'),
        deleteSysView: pick('DELETE FROM v_active_context'),
        read: pick('SELECT 1'),
        dropUserView: pick('DROP VIEW t265_user_view'),
      };
    });

    expect(r.dropSysView.kind, 'scratchpad DROP VIEW on a system view must be forbidden').toBe('forbidden');
    expect(r.dropSysView.reason).toMatch(/protected object/i);
    expect(r.createSysView.kind, 'scratchpad CREATE OR REPLACE VIEW on a system view must be forbidden').toBe('forbidden');
    expect(r.deleteSysView.kind, 'scratchpad DML on a system view must be forbidden').toBe('forbidden');

    // Non-vacuous: reads still run, user objects still droppable.
    expect(r.read.kind).toBe('read');
    expect(r.dropUserView.kind, 'user views must remain droppable in the scratchpad').toBe('ddl');
  });

  test('target extractor + predicate are targeted (user objects not flagged)', async ({ page }) => {
    await bootPage(page);
    const r = await page.evaluate(async () => {
      const { extractTargetTables, isProtectedObject } = await import('/src/schema.js');
      return {
        orReplaceView: extractTargetTables('CREATE OR REPLACE VIEW v_active_context AS SELECT 1'),
        orReplaceTable: extractTargetTables('CREATE OR REPLACE TABLE t265_x (id INTEGER)'),
        dropView: extractTargetTables('DROP VIEW v_active_context'),
        deleteView: extractTargetTables('DELETE FROM v_active_context'),
        sysView: isProtectedObject('v_active_context'),
        internalTable: isProtectedObject('messages'),
        userView: isProtectedObject('t265_user_view'),
        userTable: isProtectedObject('sample_data'),
      };
    });

    expect(r.orReplaceView).toEqual([{ name: 'v_active_context', operation: 'ddl', verb: 'CREATE' }]);
    expect(r.orReplaceTable).toEqual([{ name: 't265_x', operation: 'ddl', verb: 'CREATE' }]);
    expect(r.dropView).toEqual([{ name: 'v_active_context', operation: 'ddl', verb: 'DROP' }]);
    expect(r.deleteView).toEqual([{ name: 'v_active_context', operation: 'dml', verb: 'DELETE' }]);

    expect(r.sysView, 'a system view is a protected object').toBe(true);
    expect(r.internalTable, 'an internal table is a protected object').toBe(true);
    expect(r.userView, 'a user view is NOT protected').toBe(false);
    expect(r.userTable, 'a user table is NOT protected').toBe(false);
  });
});
