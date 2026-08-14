/**
 * Database Schema — the agent's brain.
 *
 * Pure-SQL trigger cascade (ReAct loop), scoped per session:
 *   user INSERT → agent_think → assistant INSERT → execute_tool → tool INSERT → agent_think → …
 *
 * Multi-session architecture:
 *   - `sessions` table partitions conversations
 *   - `session_context` holds the active session_id for trigger scoping
 *   - `messages` table replaces legacy `agent_memory` with token tracking
 *
 * Requires wa-sqlite JSPI build for async UDFs in triggers.
 */

export const SCHEMA_SQL = `
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- =====================================================================
-- 1. Configuration
-- =====================================================================
CREATE TABLE IF NOT EXISTS system_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO system_config (key, value) VALUES
  ('system_prompt',
    'You are an autonomous SQL-driven data analyst agent. You have access to a SQLite database and can execute SELECT queries to analyze data. '
    || 'Always write correct, safe, read-only SQL. Think step by step. '
    || 'If the user asks something you cannot answer with available data, say so honestly.'),
  ('llm_model', 'gemini-2.5-flash');

-- =====================================================================
-- 2. Tool Definitions
-- =====================================================================
CREATE TABLE IF NOT EXISTS tools (
    name   TEXT PRIMARY KEY,
    schema TEXT NOT NULL
);

INSERT OR IGNORE INTO tools (name, schema) VALUES
  ('execute_sql',
    '{"type":"function","function":{"name":"execute_sql","description":"Execute a read-only SQL query against the SQLite database. Returns JSON-formatted rows.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The SQL SELECT query to execute"}},"required":["query"]}}}'
  ),
  ('search_web',
    '{"type":"function","function":{"name":"search_web","description":"Search the web for relevant information. Returns titles, URLs, and snippets.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The search query string"}},"required":["query"]}}}'
  ),
  ('fetch_url',
    '{"type":"function","function":{"name":"fetch_url","description":"Fetch the content of a web URL. Returns the page text content.","parameters":{"type":"object","properties":{"url":{"type":"string","description":"The absolute HTTP/HTTPS URL to fetch"}},"required":["url"]}}}'
  );

-- =====================================================================
-- 3. Session Management
-- =====================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT 'Untitled',
    description TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Default session always exists
INSERT OR IGNORE INTO sessions (id, name, description)
VALUES ('default', 'Default Session', 'The primary conversation session');

-- Active session context — read by triggers to scope the ReAct cascade
CREATE TABLE IF NOT EXISTS session_context (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO session_context (key, value)
VALUES ('active_session_id', 'default');

-- T3: cascade suppression flag (set by JS during the re-insert dance after a
-- hard-error rollback so the re-inserted user row does not re-trigger agent_think).
-- Must be toggled inside a try/finally in JS — a stuck '1' permanently kills the cascade.
INSERT OR IGNORE INTO session_context (key, value)
VALUES ('suppress_cascade', '0');

-- T3: turn identity. Set by the agent_turn_init trigger to the user row's id at the
-- start of each turn; capture triggers stamp changeset rows with it. JS sets negative
-- ids for scratchpad / direct-SQL writes.
INSERT OR IGNORE INTO session_context (key, value)
VALUES ('current_turn_id', '');

-- T3: capture suppression. Set by the rewind replay (and any JS-driven bulk DML)
-- so the capture triggers don't record the rewind's own undo DML as a new turn.
INSERT OR IGNORE INTO session_context (key, value)
VALUES ('suppress_capture', '0');

-- =====================================================================
-- 4. Messages (replaces agent_memory)
-- =====================================================================
CREATE TABLE IF NOT EXISTS messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL DEFAULT 'default' REFERENCES sessions(id) ON DELETE CASCADE,
    role              TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content           TEXT,
    tool_calls        TEXT,
    tool_call_id      TEXT,
    prompt_tokens     INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    -- T9: LLM-context visibility. 1 = included in the agent_think context build
    -- (default: every normal conversation row). 0 = excluded — used by the !!
    -- scratchpad (private direct-SQL commands the agent must never see).
    in_context        INTEGER DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast session-scoped queries
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);

-- Seed system message for default session
INSERT OR IGNORE INTO messages (id, session_id, role, content)
VALUES (0, 'default', 'system', (SELECT value FROM system_config WHERE key = 'system_prompt'));

-- =====================================================================
-- 4b. Turn Changesets (T3: rolling state rewind)
--
-- Row-level pre/post images captured by per-table capture triggers. Written
-- DIRECTLY inside the turn savepoint (no staging table): a ROLLBACK TO the
-- savepoint purges a failed turn's changeset rows for free, and RELEASE
-- commits data + changeset atomically. 20-turn ring buffer; eviction is a
-- DELETE of the oldest turns (see evictChangesets in schema.js).
-- =====================================================================
CREATE TABLE IF NOT EXISTS turn_changesets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id     INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    op          TEXT NOT NULL CHECK(op IN ('I', 'U', 'D')),  -- Insert / Update / Delete
    rowid       INTEGER,
    row_before  TEXT,   -- JSON row image before the op (for U, D)
    row_after   TEXT,   -- JSON row image after the op  (for I, U)
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Ordering within a turn is by id (AUTOINCREMENT is monotonic).
CREATE INDEX IF NOT EXISTS idx_changesets_turn ON turn_changesets(session_id, turn_id, id);

-- =====================================================================
-- 4c. Turn DDL Log (T3)
--
-- DDL executed during a turn, with a pre-image so it can be undone. DDL is
-- locked from the agent in T3 (allow_dml gates DML only); this log is
-- exercised by the !!DDL scratchpad (T9) and future materialization tools
-- (T13). pre_image JSON: { create_sql, rows } — for DROP TABLE the rows are
-- captured BEFORE the drop so they can be re-inserted on rewind.
-- =====================================================================
CREATE TABLE IF NOT EXISTS turn_ddl_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id     INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    table_name  TEXT,
    ddl_sql     TEXT NOT NULL,
    pre_image   TEXT,   -- JSON: { create_sql, rows }
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ddl_log_turn ON turn_ddl_log(session_id, turn_id, id);

-- =====================================================================
-- 5. Sample Data
-- =====================================================================
CREATE TABLE IF NOT EXISTS sample_data (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    category TEXT NOT NULL,
    value    REAL NOT NULL
);

INSERT OR IGNORE INTO sample_data (id, name, category, value) VALUES
  (1, 'Widget A',  'Electronics',  29.99),
  (2, 'Widget B',  'Electronics',  49.99),
  (3, 'Gadget X',  'Accessories',  15.50),
  (4, 'Gadget Y',  'Accessories',  22.00),
  (5, 'Tool Z',    'Tools',        89.99),
  (6, 'Tool W',    'Tools',        120.00),
  (7, 'Gizmo Q',   'Electronics',  74.50),
  (8, 'Gizmo R',   'Accessories',   8.99);

-- =====================================================================
-- 6. TRIGGER 0: Turn Init (T3)
--    Fires on user-row insert, BEFORE agent_think (created first → fires
--    first). Stamps session_context.current_turn_id so capture triggers can
--    attribute every data change of the turn to it.
-- =====================================================================
DROP TRIGGER IF EXISTS agent_turn_init;
CREATE TRIGGER agent_turn_init
AFTER INSERT ON messages
WHEN NEW.role = 'user'
BEGIN
    UPDATE session_context SET value = CAST(NEW.id AS TEXT) WHERE key = 'current_turn_id';
END;

-- =====================================================================
-- 7. TRIGGER 1: Thinking Phase (session-scoped)
--    Fires when user or tool message is inserted into the active session.
--    Calls ask_llm with session-scoped context → inserts assistant response.
--    T3: suppressed while session_context.suppress_cascade = '1' (the
--    re-insert dance after a hard-error rollback).
--    T9: the context build excludes in_context = 0 rows (the !! private
--    scratchpad — the agent must never see those commands or results).
--    Drop+create (not IF NOT EXISTS) so existing brains pick up changes.
-- =====================================================================
DROP TRIGGER IF EXISTS agent_think;
CREATE TRIGGER agent_think
AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'tool')
  AND (SELECT COALESCE(value, '0') FROM session_context WHERE key = 'suppress_cascade') != '1'
BEGIN
    INSERT INTO messages (session_id, role, content, tool_calls, prompt_tokens, completion_tokens)
    SELECT
        NEW.session_id,
        'assistant',
        json_extract(llm_response, '$.content'),
        json_extract(llm_response, '$.tool_calls'),
        COALESCE(json_extract(llm_response, '$.prompt_tokens'), 0),
        COALESCE(json_extract(llm_response, '$.completion_tokens'), 0)
    FROM (
        SELECT ask_llm(
            -- Build session-scoped message context (T9: in_context = 0 rows
            -- are private scratchpad traffic — excluded from the agent's view)
            (SELECT json_group_array(json_object(
                'role', CASE WHEN role = 'tool' THEN 'tool' ELSE role END,
                'content', COALESCE(content, ''),
                'tool_calls', CASE WHEN role = 'assistant' AND tool_calls IS NOT NULL THEN json(tool_calls) ELSE NULL END,
                'tool_call_id', CASE WHEN role = 'tool' AND tool_call_id IS NOT NULL THEN tool_call_id ELSE NULL END
            )) FROM messages
            WHERE session_id = NEW.session_id
              AND COALESCE(in_context, 1) = 1
            ORDER BY id ASC),
            -- Tool definitions
            (SELECT json_group_array(json(schema)) FROM tools)
        ) AS llm_response
    );
END;

-- =====================================================================
-- 8. TRIGGER 2: Acting Phase (session-scoped)
--    Fires when assistant message with tool_calls is inserted.
--    Executes the tool → inserts tool result into same session.
-- =====================================================================
CREATE TRIGGER IF NOT EXISTS execute_tool
AFTER INSERT ON messages
WHEN NEW.role = 'assistant' AND NEW.tool_calls IS NOT NULL AND json_array_length(NEW.tool_calls) > 0
BEGIN
    INSERT INTO messages (session_id, role, content, tool_call_id)
    SELECT
        NEW.session_id,
        'tool',
        CASE json_extract(NEW.tool_calls, '$[0].function.name')
            WHEN 'execute_sql' THEN
                run_dynamic_sql(COALESCE(
                    json_extract(NEW.tool_calls, '$[0].function.arguments.query'),
                    json_extract(json_extract(NEW.tool_calls, '$[0].function.arguments'), '$.query')))
            WHEN 'search_web' THEN
                search_web(COALESCE(
                    json_extract(NEW.tool_calls, '$[0].function.arguments.query'),
                    json_extract(json_extract(NEW.tool_calls, '$[0].function.arguments'), '$.query')))
            WHEN 'fetch_url' THEN
                fetch_url(COALESCE(
                    json_extract(NEW.tool_calls, '$[0].function.arguments.url'),
                    json_extract(json_extract(NEW.tool_calls, '$[0].function.arguments'), '$.url')))
            ELSE json_object('error', 'Unknown tool: ' || json_extract(NEW.tool_calls, '$[0].function.name'))
        END,
        json_extract(NEW.tool_calls, '$[0].id');
END;
`;

/**
 * Set the active session for the ReAct trigger cascade.
 * The triggers read from session_context to know which session to operate on.
 */
export async function setActiveSession(sqlite3, db, sessionId) {
  // Ensure session exists
  for await (const stmt of sqlite3.statements(db, `INSERT OR IGNORE INTO sessions (id, name) VALUES (?, ?)`)) {
    sqlite3.bind_collection(stmt, [sessionId, sessionId]);
    await sqlite3.step(stmt);
  }
  // Ensure session_context row exists, then update
  for await (const stmt of sqlite3.statements(db, `INSERT OR IGNORE INTO session_context (key, value) VALUES ('active_session_id', 'default')`)) {
    await sqlite3.step(stmt);
  }
  for await (const stmt of sqlite3.statements(db, `UPDATE session_context SET value = ? WHERE key = 'active_session_id'`)) {
    sqlite3.bind_collection(stmt, [sessionId]);
    await sqlite3.step(stmt);
  }
}

/**
 * Create a new session and return its ID.
 */
export async function createSession(sqlite3, db, name = 'Untitled') {
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  for await (const stmt of sqlite3.statements(db, `INSERT INTO sessions (id, name) VALUES (?, ?)`)) {
    sqlite3.bind_collection(stmt, [id, name || 'Untitled']);
    await sqlite3.step(stmt);
  }
  return id;
}

/**
 * List all sessions.
 */
export async function listSessions(sqlite3, db) {
  const sessions = [];
  for await (const stmt of sqlite3.statements(db, `SELECT id, name, COALESCE(description, ''), created_at, updated_at FROM sessions ORDER BY updated_at DESC`)) {
    while (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) {
      const v = sqlite3.row(stmt);
      sessions.push({ id: v[0], name: v[1], description: v[2], created_at: v[3], updated_at: v[4] });
    }
  }
  return sessions;
}

/**
 * Delete a session and all its messages.
 */
export async function deleteSession(sqlite3, db, sessionId) {
  if (sessionId === 'default') throw new Error('Cannot delete default session');
  for await (const stmt of sqlite3.statements(db, `DELETE FROM messages WHERE session_id = ?`)) {
    sqlite3.bind_collection(stmt, [sessionId]);
    await sqlite3.step(stmt);
  }
  for await (const stmt of sqlite3.statements(db, `DELETE FROM sessions WHERE id = ?`)) {
    sqlite3.bind_collection(stmt, [sessionId]);
    await sqlite3.step(stmt);
  }
}

/**
 * Fork a session from a message ID (includes all messages up to and including that ID).
 */
export async function forkSession(sqlite3, db, sourceSessionId, forkPointId, newName = 'Forked Session') {
  const newId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  for await (const stmt of sqlite3.statements(db, `INSERT INTO sessions (id, name) VALUES (?, ?)`)) {
    sqlite3.bind_collection(stmt, [newId, newName]);
    await sqlite3.step(stmt);
  }
  for await (const stmt of sqlite3.statements(db, `
    INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, prompt_tokens, completion_tokens, in_context, created_at)
    SELECT ?, role, content, tool_calls, tool_call_id, prompt_tokens, completion_tokens, COALESCE(in_context, 1), created_at
    FROM messages WHERE session_id = ? AND id <= ?
  `)) {
    sqlite3.bind_collection(stmt, [newId, sourceSessionId, forkPointId]);
    await sqlite3.step(stmt);
  }
  return newId;
}

/**
 * Get token usage summary for a session.
 */
export async function getSessionTokenUsage(sqlite3, db, sessionId) {
  for await (const stmt of sqlite3.statements(db, `
    SELECT COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0)
    FROM messages WHERE session_id = ?
  `)) {
    sqlite3.bind_collection(stmt, [sessionId]);
    if (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) {
      const v = sqlite3.row(stmt);
      return [v[0] || 0, v[1] || 0];
    }
  }
  return [0, 0];
}

// =====================================================================
// T3: Turn Changeset Capture, Rewind Support & Boot Repair
// =====================================================================

const SQLITE_ROW = 100;

/** Quote a SQL identifier (table/column name) safely. */
export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Internal tables that are agent state / audit log / the changeset machinery
 *  itself and must NEVER be captured for rewind. Everything else in
 *  sqlite_master is a data table subject to rewind. */
const INTERNAL_TABLES = new Set([
  'messages', 'sessions', 'session_context', 'system_config', 'tools',
  'turn_changesets', 'turn_ddl_log',
]);

export function isInternalTable(name) {
  return INTERNAL_TABLES.has(name) || name.startsWith('sqlite_');
}

/** Execute a (possibly multi-statement) SQL string with optional bind params. */
export async function execParams(sqlite3, db, sql, params = []) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length) sqlite3.bind_collection(stmt, params);
    await sqlite3.step(stmt);
  }
}

/** Run a query and return all rows as arrays. */
export async function queryAll(sqlite3, db, sql, params = []) {
  const rows = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length) sqlite3.bind_collection(stmt, params);
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      rows.push(sqlite3.row(stmt));
    }
  }
  return rows;
}

/**
 * Create (or replace) the three row-image capture triggers for a data table.
 * The triggers write pre/post row images into turn_changesets, stamped with
 * session_context.current_turn_id. The column list is read from
 * PRAGMA table_info so the triggers work for any table shape.
 */
export async function ensureCaptureTriggers(sqlite3, db, tableName) {
  if (isInternalTable(tableName)) return;

  const cols = [];
  for await (const stmt of sqlite3.statements(db, `PRAGMA table_info(${quoteIdent(tableName)})`)) {
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      const v = sqlite3.row(stmt);
      cols.push(v[1]); // name is column index 1
    }
  }
  if (!cols.length) return;

  const jsonExpr = (qual) =>
    'json_object(' + cols.map(c => `'${c}', ${qual}.${quoteIdent(c)}`).join(', ') + ')';
  const turnId = "CAST(COALESCE((SELECT value FROM session_context WHERE key='current_turn_id'), '0') AS INTEGER)";
  const sessId = "(SELECT value FROM session_context WHERE key='active_session_id')";
  // Skip capture while the rewind replay (or JS bulk DML) is running.
  const noCapture = "(SELECT COALESCE(value, '0') FROM session_context WHERE key='suppress_capture') != '1'";

  const t = quoteIdent(tableName);
  const insName = `cap_${tableName}_ins`;
  const updName = `cap_${tableName}_upd`;
  const delName = `cap_${tableName}_del`;

  await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS ${insName}`);
  await execParams(sqlite3, db, `
    CREATE TRIGGER ${insName} AFTER INSERT ON ${t}
    WHEN ${noCapture}
    BEGIN
      INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid, row_after)
      VALUES (${turnId}, ${sessId}, '${tableName}', 'I', NEW.rowid, ${jsonExpr('NEW')});
    END`);

  await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS ${updName}`);
  await execParams(sqlite3, db, `
    CREATE TRIGGER ${updName} AFTER UPDATE ON ${t}
    WHEN ${noCapture}
    BEGIN
      INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid, row_before, row_after)
      VALUES (${turnId}, ${sessId}, '${tableName}', 'U', OLD.rowid, ${jsonExpr('OLD')}, ${jsonExpr('NEW')});
    END`);

  await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS ${delName}`);
  await execParams(sqlite3, db, `
    CREATE TRIGGER ${delName} AFTER DELETE ON ${t}
    WHEN ${noCapture}
    BEGIN
      INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid, row_before)
      VALUES (${turnId}, ${sessId}, '${tableName}', 'D', OLD.rowid, ${jsonExpr('OLD')});
    END`);
}

/**
 * Attach capture triggers to every user data table (idempotent). Called at
 * boot and after any table creation (CSV ingestion, agent DDL).
 */
export async function sweepCaptureTriggers(sqlite3, db) {
  const tables = await queryAll(sqlite3, db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  for (const [name] of tables) {
    if (isInternalTable(name)) continue;
    await ensureCaptureTriggers(sqlite3, db, name);
  }
}

/**
 * Evict changesets + DDL log entries older than the most recent `keepTurns`
 * distinct turns for a session (the 20-turn rolling window).
 *
 * T9: TWO independent windows — real turns (turn_id >= 0, newest = largest;
 * turn 0 = "no turn identity", e.g. CSV-ingest DML before any turn) and
 * scratchpad turns (turn_id < 0, newest = MOST negative). Mixing them in one
 * `turn_id DESC` window would rank every negative turn below every real turn,
 * so scratchpad changesets would be evicted first and the scratchpad's ⟲
 * would silently stop working after 20 real turns.
 */
export async function evictChangesets(sqlite3, db, sessionId, keepTurns = 20) {
  const keepPos = `
    SELECT turn_id FROM (
      SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id >= 0
      UNION
      SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id >= 0
    )
    ORDER BY turn_id DESC
    LIMIT ?
  `;
  const keepNeg = `
    SELECT turn_id FROM (
      SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id < 0
      UNION
      SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id < 0
    )
    ORDER BY turn_id ASC
    LIMIT ?
  `;
  await execParams(sqlite3, db,
    `DELETE FROM turn_changesets WHERE session_id = ? AND turn_id >= 0 AND turn_id NOT IN (${keepPos})`,
    [sessionId, sessionId, sessionId, keepTurns]);
  await execParams(sqlite3, db,
    `DELETE FROM turn_changesets WHERE session_id = ? AND turn_id < 0 AND turn_id NOT IN (${keepNeg})`,
    [sessionId, sessionId, sessionId, keepTurns]);
  await execParams(sqlite3, db,
    `DELETE FROM turn_ddl_log WHERE session_id = ? AND turn_id >= 0 AND turn_id NOT IN (${keepPos})`,
    [sessionId, sessionId, sessionId, keepTurns]);
  await execParams(sqlite3, db,
    `DELETE FROM turn_ddl_log WHERE session_id = ? AND turn_id < 0 AND turn_id NOT IN (${keepNeg})`,
    [sessionId, sessionId, sessionId, keepTurns]);
}

/**
 * T9: distinct scratchpad turn ids (negative) that still have rewound-able
 * changesets or DDL log rows for a session. Used to decide which scratchpad
 * bubbles get a ⟲ button.
 */
export async function getRewindableScratchpadTurns(sqlite3, db, sessionId) {
  const rows = await queryAll(sqlite3, db, `
    SELECT turn_id FROM (
      SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id < 0
      UNION
      SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id < 0
    )
  `, [sessionId, sessionId]);
  return rows.map(([t]) => t);
}

/** Toggle the cascade-suppression flag (used by the re-insert dance + boot repair). */
export async function setSuppressCascade(sqlite3, db, on) {
  await execParams(sqlite3, db,
    `UPDATE session_context SET value = ? WHERE key = 'suppress_cascade'`,
    [on ? '1' : '0']);
}

/** Toggle capture suppression (used by the rewind replay so its own undo DML
 *  is not recorded as a new turn). */
export async function setSuppressCapture(sqlite3, db, on) {
  await execParams(sqlite3, db,
    `UPDATE session_context SET value = ? WHERE key = 'suppress_capture'`,
    [on ? '1' : '0']);
}

/** Set the current turn identity (JS sets negative ids for scratchpad writes). */
export async function setCurrentTurnId(sqlite3, db, turnId) {
  await execParams(sqlite3, db,
    `UPDATE session_context SET value = ? WHERE key = 'current_turn_id'`,
    [String(turnId)]);
}

/**
 * Log a DDL statement to turn_ddl_log for the current turn, with an optional
 * pre-image ({ create_sql, rows }) so it can be undone on rewind.
 */
export async function logDDL(sqlite3, db, { turnId, sessionId, tableName = null, ddlSql, preImage = null }) {
  await execParams(sqlite3, db,
    `INSERT INTO turn_ddl_log (turn_id, session_id, table_name, ddl_sql, pre_image) VALUES (?, ?, ?, ?, ?)`,
    [turnId, sessionId, tableName, ddlSql, preImage ? JSON.stringify(preImage) : null]);
}

/**
 * Boot-time repair for orphaned tool_call pairs: an assistant row with
 * tool_calls but no matching tool row would make the next LLM API call 400.
 * Appends a synthetic tool row for each orphaned id. The cascade is
 * suppressed for the duration (try/finally) so the repair inserts don't
 * re-trigger agent_think.
 */
export async function repairOrphanedToolCalls(sqlite3, db, sessionId) {
  await setSuppressCascade(sqlite3, db, true);
  try {
    const rows = await queryAll(sqlite3, db, `
      SELECT id, tool_calls FROM messages
      WHERE session_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL
    `, [sessionId]);

    for (const [, toolCallsJson] of rows) {
      let toolCalls;
      try { toolCalls = JSON.parse(toolCallsJson); } catch { continue; }
      if (!Array.isArray(toolCalls)) continue;
      for (const tc of toolCalls) {
        const tcId = tc && tc.id;
        if (!tcId) continue;
        const existing = await queryAll(sqlite3, db,
          `SELECT id FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ?`,
          [sessionId, tcId]);
        if (existing.length) continue;
        await execParams(sqlite3, db,
          `INSERT INTO messages (session_id, role, content, tool_call_id) VALUES (?, 'tool', ?, ?)`,
          [sessionId, JSON.stringify({ error: 'Turn interrupted — tool result lost' }), tcId]);
      }
    }
  } finally {
    await setSuppressCascade(sqlite3, db, false);
  }
}

/**
 * Migration: an early T3 draft of turn_changesets / turn_ddl_log carried a
 * NOT NULL `seq` column that the final schema dropped (ordering within a turn
 * is by the AUTOINCREMENT `id`). `CREATE TABLE IF NOT EXISTS` never alters an
 * existing table, so a DB created by the draft still has the stale column and
 * the capture triggers / logDDL (which omit `seq`) fail with a NOT NULL
 * violation — silently breaking all DML capture and DDL logging.
 *
 * Drop the stale column (preserving any existing rows). Falls back to
 * drop+recreate on SQLite builds without ALTER TABLE DROP COLUMN (< 3.35).
 */
/**
 * T9 migration: existing brains have no `messages.in_context` column (added
 * with the scratchpad). `CREATE TABLE IF NOT EXISTS` never alters an existing
 * table, so add it here — every pre-existing row defaults to 1 (in context),
 * which is exactly the pre-T9 behavior.
 */
export async function migrateMessagesTable(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `PRAGMA table_info(messages)`);
  // Table doesn't exist yet (fresh brain) — SCHEMA_SQL creates it with the
  // column. MUST run before SCHEMA_SQL: the T9 agent_think trigger references
  // in_context, and CREATE TRIGGER fails on a missing column.
  if (!rows.length) return;
  if (rows.some(([, name]) => name === 'in_context')) return;
  console.warn('[schema] messages.in_context missing — adding (T9)');
  await execParams(sqlite3, db, `ALTER TABLE messages ADD COLUMN in_context INTEGER DEFAULT 1`);
}

export async function migrateTurnTables(sqlite3, db) {
  const hasCol = async (table, col) => {
    const rows = await queryAll(sqlite3, db, `PRAGMA table_info(${table})`);
    return rows.some(([, name]) => name === col);
  };
  for (const table of ['turn_changesets', 'turn_ddl_log']) {
    try {
      if (!(await hasCol(table, 'seq'))) continue;
      console.warn(`[schema] Stale 'seq' column in ${table} — dropping (ordering is by id)`);
      try {
        await execParams(sqlite3, db, `ALTER TABLE ${table} DROP COLUMN seq`);
      } catch {
        // SQLite < 3.35: no DROP COLUMN. Reset the table (rolling window / log).
        await execParams(sqlite3, db, `DROP TABLE IF EXISTS ${table}`);
        await sqlite3.exec(db, SCHEMA_SQL);
      }
    } catch (e) {
      console.warn(`[schema] migrateTurnTables(${table}) failed (non-fatal):`, e.message);
    }
  }
}
