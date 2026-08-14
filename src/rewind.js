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
  sweepCaptureTriggers,
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
  let preImage = null;
  if (preImageJson) {
    try { preImage = JSON.parse(preImageJson); } catch { /* ignore */ }
  }

  // Tolerate TEMP/TEMPORARY, extra whitespace, and newlines — the scratchpad
  // stores the statement verbatim, so match structurally, not by prefix.
  if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(ddlSql || '')) {
    await execParams(sqlite3, db, `DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
  } else if (/^DROP\s+TABLE\b/i.test(ddlSql || '')) {
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

/** Does a user table exist? (Lenient DML inverse — see replayTurnInverse.) */
async function tableExists(sqlite3, db, tableName) {
  const rows = await queryAll(sqlite3, db,
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [tableName]);
  return rows.length > 0;
}

/**
 * Apply the inverse of one turn's changes.
 *
 * T9: DDL inverses run FIRST (newest first), DML inverses second — the
 * scratchpad can interleave DML and DDL on the same table in one command
 * (e.g. `!!INSERT INTO t …; DROP TABLE t`). A DROP TABLE pre-image captures
 * the table state AFTER the turn's DML, so replaying DDL first restores the
 * full table and the DML inverse then re-applies cleanly on top of it.
 * (T3 locked DDL from the agent, so real turns have no DDL rows and this
 * order is a no-op for them.)
 *
 * DML inverses are lenient: if the DDL inverse dropped a table (e.g.
 * `!!CREATE TABLE t; INSERT INTO t …` rewound to "t gone"), the DML op on
 * that missing table is skipped — the DDL pre-image already restored the
 * complete pre-turn state.
 *
 * Known limitation (documented, rare): drop + recreate + write to the SAME
 * table within one command — the DML inverse could hit a rowid that belongs
 * to a restored pre-recreate row.
 */
async function replayTurnInverse(sqlite3, db, sessionId, turnId) {
  const ddls = await queryAll(sqlite3, db, `
    SELECT table_name, ddl_sql, pre_image
    FROM turn_ddl_log
    WHERE session_id = ? AND turn_id = ?
    ORDER BY id DESC
  `, [sessionId, turnId]);

  for (const [tableName, ddlSql, preImageJson] of ddls) {
    await replayDDLInverse(sqlite3, db, tableName, ddlSql, preImageJson);
  }

  const changes = await queryAll(sqlite3, db, `
    SELECT op, table_name, rowid, row_before, row_after
    FROM turn_changesets
    WHERE session_id = ? AND turn_id = ?
    ORDER BY id DESC
  `, [sessionId, turnId]);

  for (const [op, tableName, rowid, rowBeforeJson] of changes) {
    if (!(await tableExists(sqlite3, db, tableName))) continue;
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

    // T9: a rewound DROP TABLE restores the table from its pre-image WITHOUT
    // its capture triggers (DROP TABLE drops dependent triggers). Re-sweep so
    // the restored table is rewound-able again. Idempotent + cheap.
    try {
      await sweepCaptureTriggers(sqlite3, db);
    } catch (e) {
      console.warn('[rewind] capture-trigger re-sweep failed (non-fatal):', e.message);
    }

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

/**
 * T9: human-readable summary of what a scratchpad rewind (turn_id <= turnId,
 * turnId negative) would undo — for the confirmation modal.
 */
export async function getScratchpadChangesetSummary(sqlite3, db, sessionId, turnId) {
  const rows = await queryAll(sqlite3, db, `
    SELECT table_name, op, COUNT(*) AS n
    FROM turn_changesets
    WHERE session_id = ? AND turn_id <= ?
    GROUP BY table_name, op
    ORDER BY table_name, op
  `, [sessionId, turnId]);
  const parts = [];
  const opLabel = { I: 'inserts', U: 'updates', D: 'deletes' };
  for (const [t, op, n] of rows) {
    parts.push(`${n} ${opLabel[op] || op.toLowerCase()} on \`${t}\``);
  }
  const ddls = await queryAll(sqlite3, db, `
    SELECT COUNT(*) FROM turn_ddl_log WHERE session_id = ? AND turn_id <= ?
  `, [sessionId, turnId]);
  const ddlCount = ddls[0]?.[0] || 0;
  if (ddlCount) parts.push(`${ddlCount} DDL statement${ddlCount === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : '(no data changes recorded for these commands)';
}

/**
 * T9: rewind the database to the state before a scratchpad command — undo
 * every scratchpad turn with turn_id <= turnId (turnId is NEGATIVE; the most
 * negative = newest is replayed first). Real turns (turn_id > 0) are never
 * touched, and a scratchpad rewind can never touch real-turn changesets.
 *
 * @returns {number} the number of scratchpad turns undone.
 */
export async function rewindToBeforeScratchpadTurn(sqlite3, db, sessionId, turnId) {
  await execParams(sqlite3, db, 'SAVEPOINT rewind_sp');

  // Suppress capture so the undo DML is not recorded as a new turn.
  await setSuppressCapture(sqlite3, db, true);
  try {
    const turns = await queryAll(sqlite3, db, `
      SELECT turn_id FROM (
        SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id <= ?
        UNION
        SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id <= ?
      )
      ORDER BY turn_id ASC
    `, [sessionId, turnId, sessionId, turnId]);

    for (const [t] of turns) {
      await replayTurnInverse(sqlite3, db, sessionId, t);
    }

    // Marker so the agent knows the data changed under it. The marker is
    // in-context (default) — unlike the private scratchpad rows it replaces.
    await setSuppressCascade(sqlite3, db, true);
    try {
      await execParams(sqlite3, db,
        `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`,
        [sessionId, `⟲ Database state rewound to before scratchpad command #${-turnId} (data-only; conversation history preserved).`]);
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    // Consume the rewound changesets (they've been applied in reverse).
    await execParams(sqlite3, db,
      `DELETE FROM turn_changesets WHERE session_id = ? AND turn_id <= ?`,
      [sessionId, turnId]);
    await execParams(sqlite3, db,
      `DELETE FROM turn_ddl_log WHERE session_id = ? AND turn_id <= ?`,
      [sessionId, turnId]);

    await execParams(sqlite3, db, 'RELEASE rewind_sp');

    // A rewound DROP TABLE restores the table without its capture triggers.
    try {
      await sweepCaptureTriggers(sqlite3, db);
    } catch (e) {
      console.warn('[rewind] capture-trigger re-sweep failed (non-fatal):', e.message);
    }

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
