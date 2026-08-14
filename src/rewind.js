/**
 * REWIND ENGINE (T3) — rolling state rewind.
 *
 * Restores the database (data tables only) to the state it was in before a
 * given turn, by replaying the inverse of the recorded changesets + DDL log.
 * `messages` is an immutable audit log and is never touched — a marker row is
 * appended so the agent knows the data changed under it.
 *
 * The whole rewind runs inside a savepoint (atomic) and with capture
 * suppressed (so the undo DML is not recorded as a new turn).
 */

import {
  execParams,
  queryAll,
  quoteIdent,
  setSuppressCapture,
  setSuppressCascade,
} from './schema.js';

/**
 * Human-readable summary of the changes that would be undone by rewinding to
 * before `beforeTurnId` (for the confirmation modal).
 */
export async function getChangesetSummary(sqlite3, db, sessionId, beforeTurnId) {
  const rows = await queryAll(sqlite3, db, `
    SELECT table_name, op, COUNT(*) AS n
    FROM turn_changesets
    WHERE session_id = ? AND turn_id >= ?
    GROUP BY table_name, op
    ORDER BY table_name, op
  `, [sessionId, beforeTurnId]);
  if (!rows.length) return '(no data changes recorded for these turns)';
  const opLabel = { I: 'inserts', U: 'updates', D: 'deletes' };
  return rows
    .map(([t, op, n]) => `${n} ${opLabel[op] || op.toLowerCase()} on \`${t}\``)
    .join(', ');
}

/** Re-insert a row (from a JSON row image) at a specific rowid. */
async function reinsertRow(sqlite3, db, tableName, rowid, row) {
  const cols = Object.keys(row);
  const colList = ['rowid', ...cols].map(quoteIdent).join(', ');
  const placeholders = ['?', ...cols.map(() => '?')].join(', ');
  const values = [rowid, ...cols.map((c) => row[c])];
  await execParams(sqlite3, db,
    `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${placeholders})`,
    values);
}

/** Set a row (from a JSON row image) at a specific rowid. */
async function updateRow(sqlite3, db, tableName, rowid, row) {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const setClause = cols.map((c) => `${quoteIdent(c)} = ?`).join(', ');
  const values = [...cols.map((c) => row[c]), rowid];
  await execParams(sqlite3, db,
    `UPDATE ${quoteIdent(tableName)} SET ${setClause} WHERE rowid = ?`,
    values);
}

/** Apply the inverse of a single DDL statement (scaffold — DDL is locked from
 *  the agent in T3; exercised by the !!DDL scratchpad (T9) / T13 tools). */
async function replayDDLInverse(sqlite3, db, tableName, ddlSql, preImageJson) {
  const upper = (ddlSql || '').trim().toUpperCase();
  let preImage = null;
  if (preImageJson) {
    try { preImage = JSON.parse(preImageJson); } catch { /* ignore */ }
  }

  if (upper.startsWith('CREATE TABLE')) {
    await execParams(sqlite3, db, `DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
  } else if (upper.startsWith('DROP TABLE')) {
    if (preImage && preImage.create_sql) {
      await execParams(sqlite3, db, preImage.create_sql);
      if (Array.isArray(preImage.rows) && Array.isArray(preImage.columns) && preImage.rows.length) {
        const colList = preImage.columns.map(quoteIdent).join(', ');
        const ph = preImage.columns.map(() => '?').join(', ');
        for (const row of preImage.rows) {
          const vals = preImage.columns.map((c) => row[c]);
          await execParams(sqlite3, db,
            `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${ph})`, vals);
        }
      }
    }
  } else {
    // ALTER TABLE and other DDL are not auto-reversible — surface it.
    console.warn('[rewind] Cannot auto-reverse DDL:', ddlSql);
  }
}

/** Apply the inverse of one turn's changes (newest first) + DDL (newest first). */
async function replayTurnInverse(sqlite3, db, sessionId, turnId) {
  const changes = await queryAll(sqlite3, db, `
    SELECT op, table_name, rowid, row_before, row_after
    FROM turn_changesets
    WHERE session_id = ? AND turn_id = ?
    ORDER BY id DESC
  `, [sessionId, turnId]);

  for (const [op, tableName, rowid, rowBeforeJson] of changes) {
    if (op === 'I') {
      await execParams(sqlite3, db,
        `DELETE FROM ${quoteIdent(tableName)} WHERE rowid = ?`, [rowid]);
    } else if (op === 'D') {
      let row = {};
      try { row = JSON.parse(rowBeforeJson); } catch { /* ignore */ }
      await reinsertRow(sqlite3, db, tableName, rowid, row);
    } else if (op === 'U') {
      let row = {};
      try { row = JSON.parse(rowBeforeJson); } catch { /* ignore */ }
      await updateRow(sqlite3, db, tableName, rowid, row);
    }
  }

  const ddls = await queryAll(sqlite3, db, `
    SELECT table_name, ddl_sql, pre_image
    FROM turn_ddl_log
    WHERE session_id = ? AND turn_id = ?
    ORDER BY id DESC
  `, [sessionId, turnId]);

  for (const [tableName, ddlSql, preImageJson] of ddls) {
    await replayDDLInverse(sqlite3, db, tableName, ddlSql, preImageJson);
  }
}

/**
 * Rewind the database to the state before the turn that started at
 * `beforeTurnId` (i.e. undo every turn with turn_id >= beforeTurnId).
 *
 * @returns {number} the number of turns undone.
 */
export async function rewindToBeforeTurn(sqlite3, db, sessionId, beforeTurnId) {
  await execParams(sqlite3, db, 'SAVEPOINT rewind_sp');

  // Suppress capture so the undo DML is not recorded as a new turn.
  await setSuppressCapture(sqlite3, db, true);
  try {
    const turns = await queryAll(sqlite3, db, `
      SELECT turn_id FROM (
        SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id >= ?
        UNION
        SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id >= ?
      )
      ORDER BY turn_id DESC
    `, [sessionId, beforeTurnId, sessionId, beforeTurnId]);

    for (const [turnId] of turns) {
      await replayTurnInverse(sqlite3, db, sessionId, turnId);
    }

    // Append a marker so the agent knows the data changed under it. An
    // assistant row (no tool_calls) is visible in the chat and included in the
    // next turn's context; it fires no triggers.
    await setSuppressCascade(sqlite3, db, true);
    try {
      await execParams(sqlite3, db,
        `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`,
        [sessionId, `⟲ Database state rewound to before message #${beforeTurnId} (data-only; conversation history preserved).`]);
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    // Consume the rewound changesets (they've been applied in reverse).
    await execParams(sqlite3, db,
      `DELETE FROM turn_changesets WHERE session_id = ? AND turn_id >= ?`,
      [sessionId, beforeTurnId]);
    await execParams(sqlite3, db,
      `DELETE FROM turn_ddl_log WHERE session_id = ? AND turn_id >= ?`,
      [sessionId, beforeTurnId]);

    await execParams(sqlite3, db, 'RELEASE rewind_sp');
    return turns.length;
  } catch (e) {
    try {
      await execParams(sqlite3, db, 'ROLLBACK TO rewind_sp; RELEASE rewind_sp;');
    } catch { /* savepoint already gone */ }
    throw e;
  } finally {
    await setSuppressCapture(sqlite3, db, false);
  }
}
