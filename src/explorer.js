/**
 * EXPLORER ENGINE — Ticket 8: DB Schema Inspector, Table Stats & Interactive Data Explorer.
 *
 * Headless catalog introspection, table/view statistics, paginated data previews,
 * and DDL generators (visual table builder & view exporter).
 */

import {
  queryAll, execParams, quoteIdent, isProtectedTable, isInternalTable,
  logDDL, sweepCaptureTriggers,
} from './schema.js';

/**
 * Fetch complete database catalog partitioned into User Tables, Views, and System Tables.
 * Gathers row counts, columns (PRAGMA table_info), indexes, foreign keys, and DDL.
 */
export async function getDatabaseCatalog(sqlite3, db) {
  const masterRows = await queryAll(sqlite3, db, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `);

  const userTables = [];
  const views = [];
  const systemTables = [];

  for (const [type, name, , sql] of masterRows) {
    const isSys = isInternalTable(name);
    const item = {
      name,
      type, // 'table' | 'view'
      isSystem: isSys,
      sql: sql || '',
      rowCount: null,
      columns: [],
      indexes: [],
      foreignKeys: [],
      error: null,
    };

    // 1. Column Metadata via PRAGMA table_info
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
    } catch (e) {
      console.warn(`[explorer] PRAGMA table_info failed for ${name}:`, e);
    }

    // 2. Row Count
    try {
      const countRows = await queryAll(sqlite3, db, `SELECT COUNT(*) FROM ${quoteIdent(name)}`);
      if (countRows.length && countRows[0].length) {
        item.rowCount = Number(countRows[0][0]);
      }
    } catch (e) {
      // Views with broken references or virtual tables might fail to count
      item.rowCount = null;
      item.error = e.message;
    }

    // 3. Indexes & Foreign Keys (for user tables only)
    if (type === 'table' && !isSys) {
      try {
        const idxRows = await queryAll(sqlite3, db, `PRAGMA index_list(${quoteIdent(name)})`);
        for (const [, idxName, unique, origin, partial] of idxRows) {
          const infoRows = await queryAll(sqlite3, db, `PRAGMA index_info(${quoteIdent(idxName)})`);
          const indexedCols = infoRows.map(([, , cName]) => cName);
          item.indexes.push({
            name: idxName,
            unique: Number(unique) === 1,
            origin,
            partial: Number(partial) === 1,
            columns: indexedCols,
          });
        }
      } catch (e) {
        console.warn(`[explorer] PRAGMA index_list failed for ${name}:`, e);
      }

      // 4. Foreign Keys
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
      } catch (e) {
        console.warn(`[explorer] PRAGMA foreign_key_list failed for ${name}:`, e);
      }
    }

    if (type === 'view') {
      views.push(item);
    } else if (isSys) {
      systemTables.push(item);
    } else {
      userTables.push(item);
    }
  }

  return {
    userTables,
    views,
    systemTables,
    totalCount: masterRows.length,
    userTableCount: userTables.length,
    viewCount: views.length,
    systemTableCount: systemTables.length,
  };
}

/**
 * Parameterized data fetcher for the Data Preview Drawer.
 * Supports pagination, limit-offset, search filter, and column sorting.
 */
export async function fetchTableData(sqlite3, db, tableName, options = {}) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(options.pageSize, 10) || 25));
  const sortBy = options.sortBy || null;
  const sortDir = String(options.sortDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const filter = (options.filter || '').trim();

  // Validate object exists
  const exists = await queryAll(sqlite3, db, `
    SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')
  `, [tableName]);
  if (!exists.length) {
    throw new Error(`Table or view "${tableName}" not found.`);
  }

  // Get columns
  const colRows = await queryAll(sqlite3, db, `PRAGMA table_info(${quoteIdent(tableName)})`);
  const columnDetails = colRows.map(([cid, name, type, notnull, dflt, pk]) => ({
    cid: Number(cid),
    name,
    type: (type || 'TEXT').toUpperCase(),
    notnull: Number(notnull) === 1,
    defaultValue: dflt,
    pk: Number(pk),
  }));
  const columnNames = columnDetails.map(c => c.name);

  // Build WHERE clause if filter is provided
  let whereClause = '';
  const filterParams = [];
  if (filter && columnNames.length > 0) {
    const likeClauses = columnNames.map(col => `CAST(${quoteIdent(col)} AS TEXT) LIKE ?`);
    whereClause = `WHERE (${likeClauses.join(' OR ')})`;
    for (let i = 0; i < columnNames.length; i++) {
      filterParams.push(`%${filter}%`);
    }
  }

  // Get total matching rows
  const countSql = `SELECT COUNT(*) FROM ${quoteIdent(tableName)} ${whereClause}`;
  const countResult = await queryAll(sqlite3, db, countSql, filterParams);
  const totalRows = Number(countResult[0]?.[0] || 0);

  // Build ORDER BY clause
  let orderClause = '';
  if (sortBy && columnNames.includes(sortBy)) {
    orderClause = `ORDER BY ${quoteIdent(sortBy)} ${sortDir}`;
  }

  // Build Paginated Query
  const offset = (page - 1) * pageSize;
  const dataSql = `SELECT * FROM ${quoteIdent(tableName)} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
  const queryParams = [...filterParams, pageSize, offset];

  const rows = await queryAll(sqlite3, db, dataSql, queryParams);
  const totalPages = Math.ceil(totalRows / pageSize) || 1;

  return {
    tableName,
    columns: columnNames,
    columnDetails,
    rows,
    totalRows,
    page,
    pageSize,
    totalPages,
    filter,
    sortBy,
    sortDir,
  };
}

/**
 * Validate SQL identifier (alphanumeric & underscores, non-empty, max 64 chars).
 */
export function validateIdentifier(name, kind = 'Identifier') {
  if (typeof name !== 'string') throw new Error(`${kind} name must be a string.`);
  const trimmed = name.trim();
  if (!trimmed) throw new Error(`${kind} name cannot be empty.`);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error(`${kind} name "${trimmed}" contains invalid characters. Use letters, numbers, and underscores, starting with a letter or underscore.`);
  }
  if (trimmed.length > 64) {
    throw new Error(`${kind} name "${trimmed}" exceeds 64 characters.`);
  }
  return trimmed;
}

/**
 * Generate standard SQLite CREATE TABLE DDL from column specifications.
 */
export function generateCreateTableSql({ tableName, columns }) {
  const validTableName = validateIdentifier(tableName, 'Table');
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error('Table must have at least one column.');
  }

  const seenCols = new Set();
  const colDefs = columns.map(c => {
    const colName = validateIdentifier(c.name, 'Column');
    if (seenCols.has(colName.toLowerCase())) {
      throw new Error(`Duplicate column name: "${colName}".`);
    }
    seenCols.add(colName.toLowerCase());

    const type = String(c.type || 'TEXT').toUpperCase();
    if (!['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'].includes(type)) {
      throw new Error(`Unsupported column type: "${type}".`);
    }

    let def = `${quoteIdent(colName)} ${type}`;
    if (c.pk) {
      def += ' PRIMARY KEY';
    }
    if (c.notnull) {
      def += ' NOT NULL';
    }
    if (c.defaultValue !== undefined && c.defaultValue !== null && String(c.defaultValue).trim() !== '') {
      const val = String(c.defaultValue).trim();
      if ((type === 'INTEGER' || type === 'REAL' || type === 'NUMERIC') && !isNaN(Number(val))) {
        def += ` DEFAULT ${val}`;
      } else if (/^(CURRENT_TIMESTAMP|CURRENT_TIME|CURRENT_DATE|NULL)$/i.test(val)) {
        def += ` DEFAULT ${val.toUpperCase()}`;
      } else {
        def += ` DEFAULT '${val.replace(/'/g, "''")}'`;
      }
    }
    return '    ' + def;
  });

  return `CREATE TABLE ${quoteIdent(validTableName)} (\n${colDefs.join(',\n')}\n);`;
}

/**
 * Visual Table Builder executor: creates a table, logs DDL, sweeps triggers.
 */
export async function createTableFromSchema(sqlite3, db, { tableName, columns }) {
  const validTableName = validateIdentifier(tableName, 'Table');
  if (isProtectedTable(validTableName)) {
    throw new Error(`Cannot create table with reserved/protected name "${validTableName}".`);
  }
  const ddlSql = generateCreateTableSql({ tableName: validTableName, columns });

  // Check collision
  const existing = await queryAll(sqlite3, db, `SELECT name FROM sqlite_master WHERE name = ?`, [validTableName]);
  if (existing.length) {
    throw new Error(`Table or view "${validTableName}" already exists.`);
  }

  // Get active session and turn id
  let activeSessionId = 'default';
  let turnId = 0;
  try {
    const sRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'active_session_id'`);
    if (sRows.length) activeSessionId = sRows[0][0];
    const tRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'current_turn_id'`);
    if (tRows.length && tRows[0][0]) turnId = Number(tRows[0][0]) || 0;
  } catch { /* defaults */ }

  // Log DDL before execution
  try {
    await logDDL(sqlite3, db, {
      turnId,
      sessionId: activeSessionId,
      tableName: validTableName,
      ddlSql,
      preImage: null,
    });
  } catch (e) {
    console.warn('[explorer] logDDL warning:', e);
  }

  // Execute CREATE TABLE
  await sqlite3.exec(db, ddlSql);

  // Sweep capture triggers so new table is immediately instrumented for T3 rewind
  try {
    await sweepCaptureTriggers(sqlite3, db);
  } catch (e) {
    console.warn('[explorer] sweepCaptureTriggers failed:', e);
  }

  return {
    tableName: validTableName,
    sql: ddlSql,
  };
}

/**
 * View Exporter executor: creates a SQL view from a query string.
 */
export async function createViewFromQuery(sqlite3, db, { viewName, querySql }) {
  const validViewName = validateIdentifier(viewName, 'View');
  if (isProtectedTable(validViewName)) {
    throw new Error(`Cannot create view with reserved/protected name "${validViewName}".`);
  }
  const cleanSql = String(querySql || '').trim().replace(/;+\s*$/, '');
  if (!cleanSql) {
    throw new Error('Query SQL cannot be empty.');
  }

  // Check read-only
  const firstWord = (cleanSql.split(/\s+/)[0] || '').toUpperCase();
  if (!['SELECT', 'WITH', 'EXPLAIN'].includes(firstWord)) {
    throw new Error('Views can only be created from read-only SELECT or WITH statements.');
  }

  // Check collision
  const existing = await queryAll(sqlite3, db, `SELECT name FROM sqlite_master WHERE name = ?`, [validViewName]);
  if (existing.length) {
    throw new Error(`Table or view "${validViewName}" already exists.`);
  }

  const ddlSql = `CREATE VIEW ${quoteIdent(validViewName)} AS\n${cleanSql};`;

  // Get active session and turn id
  let activeSessionId = 'default';
  let turnId = 0;
  try {
    const sRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'active_session_id'`);
    if (sRows.length) activeSessionId = sRows[0][0];
    const tRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'current_turn_id'`);
    if (tRows.length && tRows[0][0]) turnId = Number(tRows[0][0]) || 0;
  } catch { /* defaults */ }

  // Log DDL
  try {
    await logDDL(sqlite3, db, {
      turnId,
      sessionId: activeSessionId,
      tableName: validViewName,
      ddlSql,
      preImage: null,
    });
  } catch (e) {
    console.warn('[explorer] logDDL warning:', e);
  }

  // Execute CREATE VIEW
  await sqlite3.exec(db, ddlSql);

  return {
    viewName: validViewName,
    sql: ddlSql,
  };
}

/**
 * Drop a user table or view with DDL logging and trigger sweep.
 */
export async function dropDatabaseObject(sqlite3, db, { name, type }) {
  const validName = validateIdentifier(name, 'Object');
  const objType = String(type || 'table').toLowerCase();
  if (objType !== 'table' && objType !== 'view') {
    throw new Error('Invalid object type to drop. Must be "table" or "view".');
  }

  if (isInternalTable(validName)) {
    throw new Error(`Cannot drop protected internal database object "${validName}".`);
  }

  const ddlSql = objType === 'view'
    ? `DROP VIEW IF EXISTS ${quoteIdent(validName)};`
    : `DROP TABLE IF EXISTS ${quoteIdent(validName)};`;

  let activeSessionId = 'default';
  let turnId = 0;
  try {
    const sRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'active_session_id'`);
    if (sRows.length) activeSessionId = sRows[0][0];
    const tRows = await queryAll(sqlite3, db, `SELECT value FROM session_context WHERE key = 'current_turn_id'`);
    if (tRows.length && tRows[0][0]) turnId = Number(tRows[0][0]) || 0;
  } catch { /* defaults */ }

  try {
    await logDDL(sqlite3, db, {
      turnId,
      sessionId: activeSessionId,
      tableName: validName,
      ddlSql,
      preImage: null,
    });
  } catch (e) {
    console.warn('[explorer] logDDL warning:', e);
  }

  if (objType === 'table') {
    try {
      await sqlite3.exec(db, `
        DROP TRIGGER IF EXISTS cap_${validName}_ins;
        DROP TRIGGER IF EXISTS cap_${validName}_upd;
        DROP TRIGGER IF EXISTS cap_${validName}_del;
      `);
    } catch { /* ignore */ }
  }

  await sqlite3.exec(db, ddlSql);

  try {
    await sweepCaptureTriggers(sqlite3, db);
  } catch (e) {
    console.warn('[explorer] sweepCaptureTriggers failed:', e);
  }

  return { name: validName, type: objType };
}
