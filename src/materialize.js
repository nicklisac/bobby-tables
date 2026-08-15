/**
 * TOOL-OUTPUT MATERIALIZATION ENGINE (Ticket 13)
 *
 * Transforms raw JSON blobs from prior tool results (search_web, fetch_url,
 * external API responses) into permanent, queryable SQLite tables.
 *
 * Exposed both as:
 *   1. An agent tool (`materialize(table_name, tool_call_id?)`)
 *   2. A library function for UI operations (e.g. T12 drag-and-drop handler)
 *
 * Characteristics:
 *   - Inside caller's savepoint (NO explicit BEGIN/COMMIT)
 *   - Schema inference across rows with T6-style type promotion (INTEGER -> REAL -> TEXT)
 *   - Column name deduplication with first-seen preservation
 *   - DDL logged to turn_ddl_log (enabling seamless ⟲ rewind)
 *   - User data table swept with capture triggers before populating
 *   - Returns a structured summary envelope (never transcribed data rows)
 */

import {
  quoteIdent,
  isInternalTable,
  logDDL,
  sweepCaptureTriggers,
  execParams,
  queryAll,
} from './schema.js';

/**
 * Infer SQLite type for a single cell value from JSON.
 * Native JSON types:
 *   - number (integer) -> INTEGER
 *   - number (float)   -> REAL
 *   - boolean          -> INTEGER (1 or 0)
 *   - string           -> TEXT
 *   - object / array   -> TEXT (losslessly stringified)
 *   - null / undefined -> null (does not constrain type)
 *
 * @param {*} val - JSON value
 * @returns {'INTEGER'|'REAL'|'TEXT'|null}
 */
export function inferJsonValueType(val) {
  if (val === null || val === undefined) return null;

  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) return 'TEXT';
    return Number.isInteger(val) ? 'INTEGER' : 'REAL';
  }

  if (typeof val === 'boolean') {
    return 'INTEGER';
  }

  if (typeof val === 'string') {
    return 'TEXT';
  }

  if (typeof val === 'object') {
    return 'TEXT';
  }

  return 'TEXT';
}

/**
 * Promote types along the chain: INTEGER -> REAL -> TEXT.
 *
 * @param {'INTEGER'|'REAL'|'TEXT'|null} current
 * @param {'INTEGER'|'REAL'|'TEXT'|null} newType
 * @returns {'INTEGER'|'REAL'|'TEXT'}
 */
export function promoteType(current, newType) {
  if (!current) return newType || 'TEXT';
  if (!newType) return current || 'TEXT';
  if (current === 'TEXT' || newType === 'TEXT') return 'TEXT';
  if (current === 'REAL' || newType === 'REAL') return 'REAL';
  if (current === 'INTEGER' && newType === 'INTEGER') return 'INTEGER';
  return 'TEXT';
}

/**
 * Detect payload shape and extract rows according to the locked order:
 *   (0) Columnar envelope first — explicit reject
 *   (a) Top-level array, every element a plain object -> rows
 *   (b) Plain object with exactly one non-empty array-of-objects property -> rows from it
 *   (c) Plain object, no array-of-objects property -> 1 row
 *   Anything else (scalar arrays, mixed, empty) -> error envelope
 *
 * @param {*} payload - Parsed JSON payload
 * @returns {{ rows: Array<Object> } | { error: string }}
 */
export function detectShapeAndExtractRows(payload) {
  if (payload === null || payload === undefined) {
    return { error: 'Payload is null or undefined.' };
  }

  // Refuse error envelopes from upstream tools
  if (typeof payload === 'object' && !Array.isArray(payload) && payload.error) {
    return { error: `Cannot materialize tool error: ${payload.error}` };
  }

  // (0) Columnar envelope first — explicit reject (execute_sql's shape)
  if (Array.isArray(payload) && payload.length > 0 && payload.every(item => item && typeof item === 'object' && Array.isArray(item.columns) && Array.isArray(item.values))) {
    return { error: 'Tool result is in execute_sql columnar format (re-runnable — pin a live card, or snapshot via !!CREATE TABLE … AS SELECT).' };
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.columns) && Array.isArray(payload.values)) {
    return { error: 'Tool result is in execute_sql columnar format (re-runnable — pin a live card, or snapshot via !!CREATE TABLE … AS SELECT).' };
  }

  // (a) Top-level array, every element a plain object
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return { error: 'Empty array cannot be materialized.' };
    }
    const allPlainObjects = payload.every(item => item !== null && typeof item === 'object' && !Array.isArray(item));
    if (!allPlainObjects) {
      return { error: 'Array contains non-object elements; only arrays of objects can be materialized.' };
    }
    return { rows: payload };
  }

  // (b) & (c) Plain object
  if (typeof payload === 'object') {
    const arrayObjProps = Object.keys(payload).filter(k => {
      const val = payload[k];
      return Array.isArray(val) && val.length > 0 && val.every(item => item !== null && typeof item === 'object' && !Array.isArray(item));
    });

    // (b) Exactly one non-empty array-of-objects property (e.g. search_web results)
    if (arrayObjProps.length === 1) {
      return { rows: payload[arrayObjProps[0]] };
    }

    // Two or more such properties -> ambiguous
    if (arrayObjProps.length > 1) {
      return { error: `Ambiguous structure: multiple array properties found (${arrayObjProps.join(', ')}).` };
    }

    // (c) No array-of-objects property (e.g. fetch_url single preview object) -> 1 row
    return { rows: [payload] };
  }

  return { error: 'Unsupported data shape for materialization.' };
}

/**
 * Infer column definitions and types across an array of row objects.
 * Handles key union, first-seen order, case-insensitive deduplication, and type promotion.
 *
 * @param {Array<Object>} rows
 * @returns {{ columns: Array<{ key: string, name: string, type: string }> } | { error: string }}
 */
export function inferSchemaFromRows(rows) {
  if (!rows || rows.length === 0) {
    return { error: 'No rows to infer schema from.' };
  }

  // 1. Union of keys in first-seen order
  const rawKeys = [];
  const seenRawKeys = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) {
        if (!seenRawKeys.has(k)) {
          seenRawKeys.add(k);
          rawKeys.push(k);
        }
      }
    }
  }

  if (rawKeys.length === 0) {
    return { error: 'No columns found in data.' };
  }

  // 2. Column names sanitization & case-insensitive deduplication
  const columns = [];
  const lowerSeen = new Map();

  for (let i = 0; i < rawKeys.length; i++) {
    const rawName = rawKeys[i];
    let clean = String(rawName).trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (/^[0-9]/.test(clean)) {
      clean = `col_${clean}`;
    }
    if (!clean) {
      clean = `col_${i + 1}`;
    }

    const lower = clean.toLowerCase();
    const count = lowerSeen.get(lower) || 0;
    lowerSeen.set(lower, count + 1);

    let finalName = clean;
    if (count > 0) {
      finalName = `${clean}_${count + 1}`;
      lowerSeen.set(finalName.toLowerCase(), 1);
    }

    columns.push({
      key: rawName,
      name: finalName,
      type: null,
    });
  }

  // 3. Infer types across all rows
  for (const row of rows) {
    for (const col of columns) {
      const val = row ? row[col.key] : undefined;
      const cellType = inferJsonValueType(val);
      if (cellType) {
        col.type = promoteType(col.type, cellType);
      }
    }
  }

  for (const col of columns) {
    if (!col.type) col.type = 'TEXT';
  }

  return { columns };
}

/**
 * Validate a candidate table name.
 *
 * @param {string} tableName
 * @returns {{ valid: boolean, name?: string, error?: string }}
 */
export function validateTableName(tableName) {
  if (!tableName || typeof tableName !== 'string') {
    return { valid: false, error: 'Table name must be a non-empty string.' };
  }
  const trimmed = tableName.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    return {
      valid: false,
      error: `Invalid table name '${tableName}'. Table names must start with a letter or underscore and contain only letters, numbers, and underscores.`,
    };
  }
  if (isInternalTable(trimmed) || trimmed.toLowerCase().startsWith('sqlite_')) {
    return { valid: false, error: `Table name '${tableName}' is reserved / protected.` };
  }
  return { valid: true, name: trimmed };
}

/**
 * Core materialization function.
 * Transforms a JSON tool result into a permanent, instrumented SQLite table.
 *
 * @param {object} sqlite3 - wa-sqlite instance
 * @param {number} db - SQLite database pointer
 * @param {object} options
 * @param {string} options.tableName - Destination table name
 * @param {string} [options.toolCallId] - Tool call id to resolve (optional)
 * @param {string} [options.sessionId] - Session ID (defaults to active_session_id)
 * @param {number|string} [options.turnId] - Turn ID for DDL logging (defaults to current_turn_id)
 * @param {string|object} [options.rawContent] - Direct payload (bypasses messages lookup if provided)
 * @returns {Promise<{ materialized?: boolean, table?: string, columns?: Array<{name: string, type: string}>, row_count?: number, source?: { tool_call_id: string|null }, error?: string }>}
 */
export async function materializeToolResult(sqlite3, db, {
  tableName,
  toolCallId = null,
  sessionId = null,
  turnId = null,
  rawContent = null,
} = {}) {
  try {
    // 1. Validate destination table name
    const nameCheck = validateTableName(tableName);
    if (!nameCheck.valid) {
      return { error: nameCheck.error };
    }
    const targetName = nameCheck.name;

    // 2. Collision check against sqlite_master (case-insensitive)
    const existing = await queryAll(sqlite3, db,
      `SELECT name, type FROM sqlite_master WHERE name = ? COLLATE NOCASE`,
      [targetName]);
    if (existing.length > 0) {
      return { error: `Table or ${existing[0][1]} '${existing[0][0]}' already exists.` };
    }

    // 3. Resolve session and turn IDs from context if omitted
    let effectiveSessionId = sessionId;
    if (!effectiveSessionId) {
      const sessRows = await queryAll(sqlite3, db,
        `SELECT value FROM session_context WHERE key = 'active_session_id'`);
      effectiveSessionId = sessRows.length ? sessRows[0][0] : 'default';
    }

    let effectiveTurnId = turnId;
    if (effectiveTurnId === null || effectiveTurnId === undefined) {
      const turnRows = await queryAll(sqlite3, db,
        `SELECT value FROM session_context WHERE key = 'current_turn_id'`);
      effectiveTurnId = turnRows.length && turnRows[0][0] !== '' ? parseInt(turnRows[0][0], 10) : 0;
      if (isNaN(effectiveTurnId)) effectiveTurnId = 0;
    }

    // 4. Resolve source payload
    let payload = null;
    let resolvedToolCallId = toolCallId;

    if (rawContent !== null && rawContent !== undefined) {
      if (typeof rawContent === 'string') {
        try {
          payload = JSON.parse(rawContent);
        } catch {
          return { error: 'Invalid JSON in source data.' };
        }
      } else {
        payload = rawContent;
      }
    } else {
      let rows;
      if (toolCallId) {
        rows = await queryAll(sqlite3, db,
          `SELECT content, tool_call_id FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ? ORDER BY id DESC LIMIT 1`,
          [effectiveSessionId, toolCallId]);
        if (!rows.length) {
          return { error: `Tool result for tool_call_id '${toolCallId}' not found in active session.` };
        }
      } else {
        rows = await queryAll(sqlite3, db,
          `SELECT content, tool_call_id FROM messages WHERE session_id = ? AND role = 'tool' ORDER BY id DESC LIMIT 1`,
          [effectiveSessionId]);
        if (!rows.length) {
          return { error: 'No prior tool result found in active session to materialize.' };
        }
      }

      const rawJson = rows[0][0];
      resolvedToolCallId = rows[0][1] || toolCallId;

      if (!rawJson || rawJson.trim() === '') {
        return { error: 'Tool result content is empty.' };
      }

      try {
        payload = JSON.parse(rawJson);
      } catch {
        return { error: 'Invalid JSON in tool result.' };
      }
    }

    // 5. Shape detection and row extraction
    const shapeRes = detectShapeAndExtractRows(payload);
    if (shapeRes.error) {
      return { error: shapeRes.error };
    }
    const rows = shapeRes.rows;

    // 6. Schema inference and column typing
    const schemaRes = inferSchemaFromRows(rows);
    if (schemaRes.error) {
      return { error: schemaRes.error };
    }
    const columns = schemaRes.columns;

    // 7. Generate CREATE TABLE SQL & log DDL (pre-image is null -> rewind inverse is DROP TABLE)
    const colDefs = columns.map(c => `${quoteIdent(c.name)} ${c.type}`).join(', ');
    const createSql = `CREATE TABLE ${quoteIdent(targetName)} (${colDefs});`;

    await logDDL(sqlite3, db, {
      turnId: effectiveTurnId,
      sessionId: effectiveSessionId,
      tableName: targetName,
      ddlSql: createSql,
      preImage: null,
    });

    // Execute CREATE TABLE
    await execParams(sqlite3, db, createSql);

    // 8. Sweep capture triggers BEFORE populating so INSERTs are captured into turn_changesets
    await sweepCaptureTriggers(sqlite3, db);

    // 9. Pure-SQL batch INSERT using SQLite's native json_each()
    const colNames = columns.map(c => quoteIdent(c.name)).join(', ');
    const selectExprs = columns.map(col => {
      // Escape JSON path key if needed
      const safeKey = col.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `json_extract(value, '$."${safeKey}"')`;
    }).join(', ');

    const insertSql = `INSERT INTO ${quoteIdent(targetName)} (${colNames}) SELECT ${selectExprs} FROM json_each(?);`;
    await execParams(sqlite3, db, insertSql, [JSON.stringify(rows)]);

    // 10. Return envelope without data rows
    return {
      materialized: true,
      table: targetName,
      columns: columns.map(c => ({ name: c.name, type: c.type })),
      row_count: rows.length,
      source: {
        tool_call_id: resolvedToolCallId,
      },
    };
  } catch (err) {
    console.error('[materializeToolResult]', err);
    return { error: err.message || String(err) };
  }
}
