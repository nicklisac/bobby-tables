// Ticket 26.5 (subsystem 1) — differential output-equality probe: the
// refactored getDatabaseCatalog (one query over v_schema_catalog) must
// return field-for-field what the pre-T26.5 per-object PRAGMA loop
// returned, for EVERY object in the brain — not just the seeds.
//
// The oracle below is the old algorithm verbatim: per-object
// PRAGMA table_info / index_list / index_info / foreign_key_list +
// COUNT(*), same field mapping, same pragmas' natural row order.
//
// Seeds (dropped again at the end, brain left clean):
//   - t265_probe_parent: INTEGER PK (rowid alias) + UNIQUE index + secondary index
//   - t265_probe_child:  TEXT PK (autoindex, origin 'pk') + FK with
//                        ON DELETE CASCADE / ON UPDATE SET NULL + a DEFAULT
//   - t265_probe_view:   a user view (LEFT JOIN + GROUP BY)
//
// Run from the harness (tests/specs/t26.5-explorer-catalog.spec.mjs) or the
// preview console:
//   import('/tests/probes/t26.5-explorer-catalog.mjs?t=' + Date.now())
//     .then(m => m.runT265ExplorerCatalogProbe(window.__agent.sqlite3, window.__agent.db))

import { getDatabaseCatalog } from '../../src/explorer.js';
import { queryAll, quoteIdent, isInternalTable, isSystemView } from '../../src/schema.js';

const SEED_DDL = [
  `CREATE TABLE t265_probe_parent (
     id INTEGER PRIMARY KEY,
     code TEXT NOT NULL UNIQUE,
     label TEXT
   )`,
  `CREATE INDEX idx_t265_parent_label ON t265_probe_parent(label)`,
  `CREATE TABLE t265_probe_child (
     id TEXT PRIMARY KEY,
     parent_id INTEGER NOT NULL REFERENCES t265_probe_parent(id) ON DELETE CASCADE ON UPDATE SET NULL,
     note TEXT DEFAULT 'x'
   )`,
  `CREATE VIEW t265_probe_view AS
     SELECT p.id, p.code, COUNT(c.id) AS n
     FROM t265_probe_parent p
     LEFT JOIN t265_probe_child c ON c.parent_id = p.id
     GROUP BY p.id, p.code`,
];

/**
 * The pre-T26.5 getDatabaseCatalog per-object algorithm, verbatim (same
 * PRAGMAs, same field mapping, same natural row order). This is the oracle
 * the refactored catalog must match field-for-field.
 */
async function oracleItem(sqlite3, db, type, name, sql) {
  const item = {
    name,
    type,
    sql: sql || '',
    rowCount: null,
    columns: [],
    indexes: [],
    foreignKeys: [],
    error: null,
  };

  try {
    const colRows = await queryAll(sqlite3, db, `PRAGMA table_info(${quoteIdent(name)})`);
    item.columns = colRows.map(([cid, colName, colType, notnull, dfltValue, pk]) => ({
      cid: Number(cid),
      name: colName,
      type: (colType || 'TEXT').toUpperCase(),
      notnull: Number(notnull) === 1,
      defaultValue: dfltValue,
      pk: Number(pk),
    }));
  } catch { /* mirrors the old per-object warn-and-continue */ }

  try {
    const countRows = await queryAll(sqlite3, db, `SELECT COUNT(*) FROM ${quoteIdent(name)}`);
    if (countRows.length && countRows[0].length) {
      item.rowCount = Number(countRows[0][0]);
    }
  } catch (e) {
    item.rowCount = null;
    item.error = e.message;
  }

  if (type === 'table' && !isInternalTable(name)) {
    try {
      const idxRows = await queryAll(sqlite3, db, `PRAGMA index_list(${quoteIdent(name)})`);
      for (const [, idxName, unique, origin, partial] of idxRows) {
        const infoRows = await queryAll(sqlite3, db, `PRAGMA index_info(${quoteIdent(idxName)})`);
        item.indexes.push({
          name: idxName,
          unique: Number(unique) === 1,
          origin,
          partial: Number(partial) === 1,
          columns: infoRows.map(([, , cName]) => cName),
        });
      }
    } catch { /* mirrors the old per-object warn-and-continue */ }

    try {
      const fkRows = await queryAll(sqlite3, db, `PRAGMA foreign_key_list(${quoteIdent(name)})`);
      item.foreignKeys = fkRows.map(([id, seq, toTable, fromCol, toCol, onUpdate, onDelete, match]) => ({
        id: Number(id),
        seq: Number(seq),
        toTable,
        fromCol,
        toCol,
        onUpdate,
        onDelete,
        match,
      }));
    } catch { /* mirrors the old per-object warn-and-continue */ }
  }

  return item;
}

export async function runT265ExplorerCatalogProbe(sqlite3, db) {
  const R = { ok: false, steps: {} };

  // ── Seed the interesting shapes ──
  for (const ddl of SEED_DDL) {
    await sqlite3.exec(db, ddl);
  }
  await queryAll(sqlite3, db,
    `INSERT INTO t265_probe_parent (code, label) VALUES ('a', 'alpha'), ('b', 'beta')`);
  await queryAll(sqlite3, db,
    `INSERT INTO t265_probe_child (id, parent_id, note) VALUES ('c1', 1, 'n1'), ('c2', 1, 'n2'), ('c3', 2, 'n3')`);

  try {
    // ── Oracle: the pre-T26.5 algorithm over the whole brain ──
    const masterRows = await queryAll(sqlite3, db, `
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `);
    const oracle = {};
    for (const [type, name, , sql] of masterRows) {
      oracle[name] = await oracleItem(sqlite3, db, type, name, sql);
    }

    // ── The refactored catalog ──
    const catalog = await getDatabaseCatalog(sqlite3, db);
    const byName = {};
    for (const bucket of ['userTables', 'views', 'systemViews', 'systemTables']) {
      for (const item of catalog[bucket]) byName[item.name] = { ...item, bucket };
    }

    // 1. Same object set.
    const oracleNames = Object.keys(oracle).sort();
    const catalogNames = Object.keys(byName).sort();
    R.steps.objectSet = {
      ok: JSON.stringify(oracleNames) === JSON.stringify(catalogNames),
      oracleNames,
      catalogNames,
    };

    // 2. Field-for-field equality for every object.
    const mismatches = [];
    for (const name of oracleNames) {
      const o = oracle[name];
      const c = byName[name];
      if (!c) {
        mismatches.push({ name, problem: 'missing from catalog' });
        continue;
      }
      for (const field of ['type', 'sql', 'rowCount', 'columns', 'indexes', 'foreignKeys', 'error']) {
        if (JSON.stringify(o[field]) !== JSON.stringify(c[field])) {
          mismatches.push({ name, field, oracle: o[field], catalog: c[field] });
        }
      }
    }
    R.steps.fieldEquality = {
      ok: mismatches.length === 0,
      count: oracleNames.length,
      mismatches,
    };

    // 3. Partitioning (the T26.5 delineation: app views → systemViews).
    const partitionErrors = [];
    for (const name of oracleNames) {
      const o = oracle[name];
      const expected = o.type === 'view'
        ? (isSystemView(name) ? 'systemViews' : 'views')
        : (isInternalTable(name) ? 'systemTables' : 'userTables');
      if (byName[name] && byName[name].bucket !== expected) {
        partitionErrors.push({ name, expected, got: byName[name].bucket });
      }
    }
    R.steps.partition = {
      ok: partitionErrors.length === 0,
      errors: partitionErrors,
      systemViews: catalog.systemViews.map((v) => v.name).sort(),
      views: catalog.views.map((v) => v.name).sort(),
    };

    // 4. Count fields agree with the buckets.
    R.steps.counts = {
      ok: catalog.totalCount === oracleNames.length
        && catalog.userTableCount === catalog.userTables.length
        && catalog.viewCount === catalog.views.length
        && catalog.systemViewCount === catalog.systemViews.length
        && catalog.systemTableCount === catalog.systemTables.length,
      catalog: {
        total: catalog.totalCount,
        user: catalog.userTableCount,
        views: catalog.viewCount,
        systemViews: catalog.systemViewCount,
        systemTables: catalog.systemTableCount,
      },
    };

    // 5. The seeds actually exercised the interesting shapes (guards against
    //    a vacuous equality pass if the seeds silently failed to create).
    const parent = byName['t265_probe_parent'];
    const child = byName['t265_probe_child'];
    const view = byName['t265_probe_view'];
    const fk = child && child.foreignKeys[0] || {};
    R.steps.seedShapes = {
      ok: parent
        && parent.indexes.length === 2
        && parent.indexes.some((i) => i.origin === 'u' && i.unique)
        && parent.indexes.some((i) => i.origin === 'c')
        && child
        && child.indexes.length === 1
        && child.indexes[0].origin === 'pk'
        && child.indexes[0].columns.join(',') === 'id'
        && fk.toTable === 't265_probe_parent'
        && fk.fromCol === 'parent_id'
        && fk.toCol === 'id'
        && String(fk.onDelete).toUpperCase() === 'CASCADE'
        && String(fk.onUpdate).toUpperCase() === 'SET NULL'
        && view
        && view.columns.length === 3
        && view.rowCount === 2,
      parentIndexes: parent ? parent.indexes : null,
      childIndexes: child ? child.indexes : null,
      childForeignKeys: child ? child.foreignKeys : null,
      viewColumns: view ? view.columns : null,
      viewRowCount: view ? view.rowCount : null,
    };

    R.ok = [R.steps.objectSet, R.steps.fieldEquality, R.steps.partition, R.steps.counts, R.steps.seedShapes]
      .every((s) => s.ok);
    return R;
  } finally {
    // Leave the brain clean.
    await sqlite3.exec(db, `DROP VIEW IF EXISTS t265_probe_view`).catch(() => {});
    await sqlite3.exec(db, `DROP TABLE IF EXISTS t265_probe_child`).catch(() => {});
    await sqlite3.exec(db, `DROP TABLE IF EXISTS t265_probe_parent`).catch(() => {});
  }
}
