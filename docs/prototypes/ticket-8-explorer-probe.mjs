// Ticket 8 DB Schema Inspector & Data Explorer probe — end-to-end verification.
//
// Run in the browser console (Vite dev server :5174):
//   import('/docs/prototypes/ticket-8-explorer-probe.mjs').then(m => m.runT8Probe())
//
// Returns { ok, steps: {...}, summary: '...' }.

import {
  getDatabaseCatalog,
  fetchTableData,
  validateIdentifier,
  generateCreateTableSql,
  createTableFromSchema,
  createViewFromQuery,
  dropDatabaseObject,
} from '../../src/explorer.js';
import {
  queryAll, execParams, setSuppressCascade,
  createSession, renameSession, deleteSession, listSessions,
} from '../../src/schema.js';

export async function runT8Probe() {
  const R = { steps: {} };
  const { sqlite3, db } = window.__agent;

  console.log('🚀 Starting Ticket 8 DB Schema Inspector & Data Explorer Probe...');

  // ─────────────────────────────────────────────────────────────────────
  // Step 1: Catalog Introspection & Partitioning
  // ─────────────────────────────────────────────────────────────────────
  {
    const catalog = await getDatabaseCatalog(sqlite3, db);
    const userNames = catalog.userTables.map(t => t.name);
    const sysNames = catalog.systemTables.map(t => t.name);
    const viewNames = catalog.views.map(v => v.name);
    const sysViewNames = (catalog.systemViews || []).map(v => v.name);

    const hasSampleData = userNames.includes('sample_data');
    const hasMessages = sysNames.includes('messages');
    const hasCards = sysNames.includes('dashboard_cards');
    // T26.5: app views are system objects, partitioned into systemViews.
    const hasActiveContext = sysViewNames.includes('v_active_context');

    const sampleTable = catalog.userTables.find(t => t.name === 'sample_data');
    const hasCols = sampleTable && sampleTable.columns.length > 0;
    const hasRowCount = sampleTable && typeof sampleTable.rowCount === 'number';

    const ok = hasSampleData && hasMessages && hasCards && hasActiveContext && hasCols && hasRowCount;
    R.steps.step1_catalog = {
      ok,
      userTablesCount: catalog.userTables.length,
      viewsCount: catalog.views.length,
      systemViewsCount: catalog.systemViews ? catalog.systemViews.length : 0,
      systemTablesCount: catalog.systemTables.length,
      sampleDataStats: sampleTable ? { rows: sampleTable.rowCount, cols: sampleTable.columns.length } : null,
    };
    if (!ok) throw new Error('Step 1 Failed: catalog partitioning or metadata incomplete');
    console.log('  ✓ Step 1: Catalog Introspection & Partitioning passed');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: Paginated Data Fetching, Filtering & Sorting
  // ─────────────────────────────────────────────────────────────────────
  {
    // Page 1 with pageSize 3
    const p1 = await fetchTableData(sqlite3, db, 'sample_data', { page: 1, pageSize: 3 });
    // Page 2 with pageSize 3
    const p2 = await fetchTableData(sqlite3, db, 'sample_data', { page: 2, pageSize: 3 });
    // Filter by text
    const pFilter = await fetchTableData(sqlite3, db, 'sample_data', { filter: 'Electronics' });
    // Sorted by price DESC
    const pSort = await fetchTableData(sqlite3, db, 'sample_data', { sortBy: 'price', sortDir: 'DESC' });

    console.log('Step 2 debug:', {
      p1Rows: p1.rows.length,
      p2Rows: p2.rows.length,
      p1Total: p1.totalRows,
      pFilterRows: pFilter.rows.length,
      pSortRows: pSort.rows.length,
      p1Row0: p1.rows[0],
      p2Row0: p2.rows[0],
    });

    const p1RowsDistinct = p1.rows.length === 3;
    const p2RowsDistinct = p2.rows.length === 3 && JSON.stringify(p1.rows[0]) !== JSON.stringify(p2.rows[0]);
    const filterOk = pFilter.rows.length > 0 && pFilter.rows.length <= p1.totalRows;
    const sortOk = pSort.rows.length === p1.totalRows;

    const ok = p1RowsDistinct && p2RowsDistinct && filterOk && sortOk;
    R.steps.step2_pagination = {
      ok,
      totalRows: p1.totalRows,
      totalPages: p1.totalPages,
      page1Count: p1.rows.length,
      page2Count: p2.rows.length,
      filteredCount: pFilter.rows.length,
    };
    if (!ok) throw new Error(`Step 2 Failed: p1=${p1.rows.length}, p2=${p2.rows.length}, filter=${pFilter.rows.length}, sort=${pSort.rows.length}`);
    console.log('  ✓ Step 2: Paginated Data Fetching, Filtering & Sorting passed');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 3: DDL Generation & Visual Table Creation
  // ─────────────────────────────────────────────────────────────────────
  {
    const tableName = 'probe_inventory';
    const columns = [
      { name: 'id', type: 'INTEGER', pk: true, notnull: true },
      { name: 'sku', type: 'TEXT', pk: false, notnull: true },
      { name: 'stock', type: 'INTEGER', pk: false, notnull: false, defaultValue: '0' },
    ];

    const generatedSql = generateCreateTableSql({ tableName, columns });
    const hasPk = generatedSql.includes('PRIMARY KEY');
    const hasDflt = generatedSql.includes('DEFAULT 0');

    // Create Table
    await createTableFromSchema(sqlite3, db, { tableName, columns });

    // Verify table exists in catalog
    const cat = await getDatabaseCatalog(sqlite3, db);
    const createdTable = cat.userTables.find(t => t.name === tableName);

    // Verify DDL logged
    const ddlLogs = await queryAll(sqlite3, db, `SELECT ddl_sql FROM turn_ddl_log WHERE table_name = ?`, [tableName]);

    // Verify capture triggers were attached
    const triggers = await queryAll(sqlite3, db, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_probe_inventory_%'`);

    // Insert test data
    await execParams(sqlite3, db, `INSERT INTO probe_inventory (id, sku, stock) VALUES (1, 'SKU-001', 50), (2, 'SKU-002', 15)`);
    const data = await fetchTableData(sqlite3, db, tableName);

    const ok = hasPk && hasDflt && createdTable && ddlLogs.length > 0 && triggers.length === 3 && data.totalRows === 2;
    R.steps.step3_create_table = {
      ok,
      tableName,
      triggerCount: triggers.length,
      ddlLogged: ddlLogs.length > 0,
      rowsInserted: data.totalRows,
    };
    if (!ok) throw new Error('Step 3 Failed: table creation, trigger attachment, or DDL log error');
    console.log('  ✓ Step 3: DDL Generation & Visual Table Creation passed');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: SQL View Creation ("Save as View" engine)
  // ─────────────────────────────────────────────────────────────────────
  {
    const viewName = 'v_probe_high_stock';
    const querySql = 'SELECT sku, stock FROM probe_inventory WHERE stock > 20';

    await createViewFromQuery(sqlite3, db, { viewName, querySql });

    const cat = await getDatabaseCatalog(sqlite3, db);
    const createdView = cat.views.find(v => v.name === viewName);

    const viewData = await fetchTableData(sqlite3, db, viewName);
    const hasColumns = viewData.columns.includes('sku') && viewData.columns.includes('stock');
    const matchingRows = viewData.totalRows === 1; // only SKU-001 (50) > 20

    const ok = createdView && hasColumns && matchingRows;
    R.steps.step4_create_view = {
      ok,
      viewName,
      columns: viewData.columns,
      totalRows: viewData.totalRows,
    };
    if (!ok) throw new Error('Step 4 Failed: view creation or view query evaluation error');
    console.log('  ✓ Step 4: SQL View Creation ("Save as View") passed');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 5: Dropping Database Objects & Trigger Sweeps
  // ─────────────────────────────────────────────────────────────────────
  {
    // Drop view
    await dropDatabaseObject(sqlite3, db, { name: 'v_probe_high_stock', type: 'view' });
    // Drop table
    await dropDatabaseObject(sqlite3, db, { name: 'probe_inventory', type: 'table' });

    const cat = await getDatabaseCatalog(sqlite3, db);
    const viewGone = !cat.views.some(v => v.name === 'v_probe_high_stock');
    const tableGone = !cat.userTables.some(t => t.name === 'probe_inventory');

    // Verify triggers cleaned up
    const triggers = await queryAll(sqlite3, db, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_probe_inventory_%'`);

    const ok = viewGone && tableGone && triggers.length === 0;
    R.steps.step5_drop_objects = {
      ok,
      viewGone,
      tableGone,
      remainingTriggers: triggers.length,
    };
    if (!ok) throw new Error('Step 5 Failed: object dropping or trigger cleanup error');
    console.log('  ✓ Step 5: Dropping Database Objects & Trigger Sweeps passed');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 6: Protection & Safety Bounds
  // ─────────────────────────────────────────────────────────────────────
  {
    let blockedSysDrop = false;
    try {
      await dropDatabaseObject(sqlite3, db, { name: 'messages', type: 'table' });
    } catch (e) {
      blockedSysDrop = e.message.includes('Cannot drop protected internal database object');
    }

    let blockedDmlView = false;
    try {
      await createViewFromQuery(sqlite3, db, { viewName: 'v_bad', querySql: 'DELETE FROM sample_data' });
    } catch (e) {
      blockedDmlView = e.message.includes('read-only SELECT');
    }

    let blockedBadIdent = false;
    try {
      validateIdentifier('123-bad-name', 'Table');
    } catch (e) {
      blockedBadIdent = e.message.includes('invalid characters');
    }

    const ok = blockedSysDrop && blockedDmlView && blockedBadIdent;
    R.steps.step6_safety = {
      ok,
      blockedSysDrop,
      blockedDmlView,
      blockedBadIdent,
    };
    if (!ok) throw new Error('Step 6 Failed: safety checks did not reject invalid commands');
    console.log('  ✓ Step 6: Protection & Safety Bounds passed');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 7: UI Controller & Live Handles
  // ─────────────────────────────────────────────────────────────────────
  {
    const hasExplorerEngine = !!window.__agent?.explorer;
    const hasExplorerUi = !!window.__agent?.explorerUi;

    // Trigger renderExplorer and test message rendering with tool outputs
    let renderClean = false;
    try {
      await window.__agent.explorerUi.renderExplorer();
      renderClean = true;
    } catch (e) {
      console.warn('renderExplorer probe error:', e);
    }

    const ok = hasExplorerEngine && hasExplorerUi && renderClean;
    R.steps.step7_ui_controller = {
      ok,
      hasExplorerEngine,
      hasExplorerUi,
      renderClean,
    };
    if (!ok) throw new Error('Step 7 Failed: UI controller or handles not properly registered');
    console.log('  ✓ Step 7: UI Controller & Live Handles passed');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Step 8: Session Management (Create, Rename, Delete & Deduplication)
  // ─────────────────────────────────────────────────────────────────────
  {
    // Create new session
    const sessId = await createSession(sqlite3, db, 'Probe Session Alpha');
    const s1 = await listSessions(sqlite3, db);
    const createdFound = s1.find(s => s.id === sessId);

    // Rename session
    await renameSession(sqlite3, db, sessId, 'Probe Session Renamed');
    const s2 = await listSessions(sqlite3, db);
    const renamedFound = s2.find(s => s.id === sessId && s.name === 'Probe Session Renamed');

    // Insert dummy messages into session
    await queryAll(sqlite3, db, `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'Ping')`, [sessId]);
    await queryAll(sqlite3, db, `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', 'Pong')`, [sessId]);

    // Delete session
    await deleteSession(sqlite3, db, sessId);
    const s3 = await listSessions(sqlite3, db);
    const deletedInList = s3.find(s => s.id === sessId);

    // Verify messages purged
    const msgRows = await queryAll(sqlite3, db, `SELECT COUNT(*) FROM messages WHERE session_id = ?`, [sessId]);
    const msgsRemaining = msgRows.length ? msgRows[0][0] : 0;

    const ok = createdFound && renamedFound && !deletedInList && msgsRemaining === 0;
    R.steps.step8_session_lifecycle = {
      ok,
      created: !!createdFound,
      renamed: !!renamedFound,
      deleted: !deletedInList,
      messagesPurged: msgsRemaining === 0,
    };
    if (!ok) throw new Error('Step 8 Failed: Session lifecycle operations failed');
    console.log('  ✓ Step 8: Session Lifecycle (Create, Rename, Delete) passed');
  }

  R.ok = Object.values(R.steps).every(s => s.ok);
  R.summary = 'All 8 Ticket 8 DB Schema Inspector, Table Stats & Session Lifecycle steps PASSED!';
  console.log('🎉 Ticket 8 Probe Result:', R);
  return R;
}
