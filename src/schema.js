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
     'You are Tables — a SQL-driven agent living inside an in-browser SQLite database.'
     || char(10) || char(10)
     || 'Your memory, session state, and conversation history are stored directly in SQLite tables (messages, sessions, turn_changesets).'
     || char(10) || '- You use SQL queries to inspect schemas, explore data, and verify facts before answering.'
     || char(10) || '- You have tools to execute SQL queries, search the web, fetch web pages, and materialize JSON outputs into permanent SQLite tables.'
     || char(10) || char(10)
     || 'Guidelines:'
     || char(10) || '1. Check the schema and query tables directly rather than guessing table structures or column names.'
     || char(10) || '2. When external web data is needed, search or fetch it, then use the materialize tool to convert JSON results into queryable SQLite tables.'
     || char(10) || '3. Write standard, readable SQLite queries (CTEs, window functions, and json_extract where appropriate).'
     || char(10) || '4. Present clear, concise summaries of your findings with the relevant data points.'
     || char(10) || '5. Help users analyze datasets, create database views, and build dashboard queries.'),
  ('llm_model', 'gemini-2.5-flash'),
  ('allow_dml', '1'),
  -- T2: fallback effective context window (tau's DEFAULT_CONTEXT_WINDOW_TOKENS).
  -- The LIVE window resolves as: user override (settings field, written to this
  -- same key) -> cloud model-name lookup -> this fallback. The 85% compaction
  -- threshold and the tail formula are code constants (compaction.js), not stored.
  ('effective_context_window', '128000');

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
  ),
  ('materialize',
    '{"type":"function","function":{"name":"materialize","description":"Materialize raw JSON output from a prior tool call into a permanent, queryable SQLite table. Useful for storing web search results, fetched web page data, or external API responses so they can be queried with SQL.","parameters":{"type":"object","properties":{"table_name":{"type":"string","description":"The name for the new SQLite table to create (must be a valid identifier that does not already exist)"},"tool_call_id":{"type":"string","description":"Optional: the specific tool_call_id whose result should be materialized. If omitted, uses the most recent tool output in the session."}},"required":["table_name"]}}}'
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
-- 4d. Compactions (T2: interval compaction via in-session watermark)
--
-- Holds SUMMARIES ONLY. The messages table is untouched by design — no
-- watermark column, no rows added/moved/deleted/flagged. A compaction row
-- points at the last summarized message (watermark_id); the v_active_context
-- view simply stops reading rows below that watermark. seq = 0,1,2,… per session
-- ("which compaction are we on"); the view reads only max(seq) — earlier rows
-- stay as provenance (their newest summary subsumed them).
-- =====================================================================
CREATE TABLE IF NOT EXISTS compactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    summary      TEXT NOT NULL,
    watermark_id INTEGER NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id, seq);

-- =====================================================================
-- 4e. v_active_context (T2: the LLM's working context)
--
-- [system row (id=0, if present)] + [latest rolling summary rendered as a
-- synthetic user row, tau-style "Previous conversation summary:" wrapper]
-- + [in_context=1 rows with id > latest watermark].
--
-- Emits a ctx_order column (system=0, summary=1, messages=id+1) because the
-- synthetic summary row cannot sort between id=0 and id=1 as a raw id.
--
-- C2 (from the draft): views take no parameters — the view pins to the active
-- session via session_context. Safe because the ReAct cascade only ever runs
-- on the active session (the trigger's WHERE session_id = NEW.session_id is
-- belt-and-braces).
--
-- DROP VIEW + recreate (not IF NOT EXISTS) so existing brains pick up changes
-- (the superseded sliding-window draft may exist in dev brains).
-- =====================================================================
DROP VIEW IF EXISTS v_active_context;
CREATE VIEW v_active_context AS
WITH active AS (
    SELECT value AS session_id FROM session_context WHERE key = 'active_session_id'
),
latest AS (
    -- The current compaction = max(seq) per session.
    SELECT c.session_id, c.seq, c.summary, c.watermark_id
    FROM compactions c
    WHERE c.seq = (SELECT MAX(seq) FROM compactions WHERE session_id = c.session_id)
)
SELECT 0 AS ctx_order, m.id AS id, m.session_id AS session_id, 'system' AS role,
       m.content AS content, NULL AS tool_calls, NULL AS tool_call_id
FROM messages m
CROSS JOIN active a
WHERE m.id = 0 AND m.session_id = a.session_id
UNION ALL
SELECT 1 AS ctx_order, -1 AS id, l.session_id AS session_id, 'user' AS role,
       ('Previous conversation summary:' || char(10) || l.summary) AS content,
       NULL AS tool_calls, NULL AS tool_call_id
FROM latest l
CROSS JOIN active a
WHERE l.session_id = a.session_id
UNION ALL
SELECT (m.id + 1) AS ctx_order, m.id AS id, m.session_id AS session_id, m.role AS role,
       m.content AS content, m.tool_calls AS tool_calls, m.tool_call_id AS tool_call_id
FROM messages m
CROSS JOIN active a
LEFT JOIN latest l ON l.session_id = a.session_id
WHERE m.session_id = a.session_id
  AND COALESCE(m.in_context, 1) = 1
   AND m.id != 0  -- the system row (id=0) is emitted by Branch 1, not here
  AND (l.watermark_id IS NULL OR m.id > l.watermark_id)
ORDER BY ctx_order ASC;

-- =====================================================================
-- 4f. Dashboard Cards (T11: 3-pane workstation — right-pane grid)
--
-- UI state for the 3x3 reactive canvas, GLOBAL to the brain (no session_id —
-- the grid is a workstation view over the DATA, not a conversation artifact;
-- it persists across session switches and is untouched by fork/delete).
--
-- Placement: explicit grid coordinates on a fixed 3x3 grid. row/col = top-
-- left cell (0-based); row_span/col_span = merged-cell extent (1-3). The grid
-- engine (src/grid.js) enforces bounds + non-overlap in JS; the CHECK
-- constraints are belt-and-braces for direct SQL (e.g. T12's drag-drop
-- INSERT INTO dashboard_cards).
--
-- Cards are READ-ONLY: their sql must be a single SELECT/WITH/EXPLAIN
-- statement (enforced by the grid engine at add/edit time). That keeps card
-- execution outside T3's changeset capture and safe to re-run at any time.
--
-- dashboard_cards is in INTERNAL_TABLES (below): no row-image capture
-- triggers are attached, so card CRUD never pollutes turn_changesets and a
-- turn rewind never reverts the dashboard layout (grid = UI state, not data
-- state). Cartridge export (T10) includes it automatically (page-level
-- backup / VACUUM INTO).
-- =====================================================================
CREATE TABLE IF NOT EXISTS dashboard_cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    sql        TEXT NOT NULL,
    row        INTEGER NOT NULL DEFAULT 0 CHECK(row >= 0),
    col        INTEGER NOT NULL DEFAULT 0 CHECK(col >= 0 AND col <= 2),
    row_span   INTEGER NOT NULL DEFAULT 1 CHECK(row_span >= 1),
    col_span   INTEGER NOT NULL DEFAULT 1 CHECK(col_span >= 1 AND col_span <= 3),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
            -- T2: build session-scoped context from v_active_context =
            -- [system, latest rolling summary (synthetic user row), rows after
            -- the compaction watermark]. The view already applies the T9
            -- in_context = 1 filter and the watermark; ctx_order gives
            -- system=0, summary=1, messages=id+1.
            (SELECT json_group_array(json_object(
                'role', CASE WHEN role = 'tool' THEN 'tool' ELSE role END,
                'content', COALESCE(content, ''),
                'tool_calls', CASE WHEN role = 'assistant' AND tool_calls IS NOT NULL THEN json(tool_calls) ELSE NULL END,
                'tool_call_id', CASE WHEN role = 'tool' AND tool_call_id IS NOT NULL THEN tool_call_id ELSE NULL END
            )) FROM v_active_context
            WHERE session_id = NEW.session_id
            ORDER BY ctx_order ASC),
            -- Tool definitions
            (SELECT json_group_array(json(schema)) FROM tools)
        ) AS llm_response
    );
END;

-- =====================================================================
-- 8. TRIGGER 2: Acting Phase (session-scoped)
--    Fires when assistant message with tool_calls is inserted.
--    Executes the tool → inserts tool result into same session.
--    T3: suppressed while session_context.suppress_cascade = '1' — same gate
--    as agent_think. Required for T1 forking: forkSession copies messages
--    (including assistant rows with tool_calls) with the cascade suppressed;
--    without this gate the copy would RE-EXECUTE the tools into the fork.
--    Drop+create (not IF NOT EXISTS) so existing brains pick up the gate.
-- =====================================================================
DROP TRIGGER IF EXISTS execute_tool;
CREATE TRIGGER execute_tool
AFTER INSERT ON messages
WHEN NEW.role = 'assistant' AND NEW.tool_calls IS NOT NULL AND json_array_length(NEW.tool_calls) > 0
  AND (SELECT COALESCE(value, '0') FROM session_context WHERE key = 'suppress_cascade') != '1'
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
            WHEN 'materialize' THEN
                materialize(
                    COALESCE(
                        json_extract(NEW.tool_calls, '$[0].function.arguments.table_name'),
                        json_extract(json_extract(NEW.tool_calls, '$[0].function.arguments'), '$.table_name')),
                    COALESCE(
                        json_extract(NEW.tool_calls, '$[0].function.arguments.tool_call_id'),
                        json_extract(json_extract(NEW.tool_calls, '$[0].function.arguments'), '$.tool_call_id'))
                )
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
  if (sessionId === 'default') {
    for await (const stmt of sqlite3.statements(db, `
      INSERT OR IGNORE INTO sessions (id, name, description)
      VALUES ('default', 'Default Session', 'The primary conversation session')
    `)) {
      await sqlite3.step(stmt);
    }
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
export async function createSession(sqlite3, db, name = 'New Session') {
  const cleanName = String(name || '').trim() || 'New Session';
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  for await (const stmt of sqlite3.statements(db, `INSERT INTO sessions (id, name) VALUES (?, ?)`)) {
    sqlite3.bind_collection(stmt, [id, cleanName]);
    await sqlite3.step(stmt);
  }
  return id;
}

/**
 * List all sessions, strictly deduplicated by session ID.
 */
export async function listSessions(sqlite3, db) {
  const sessions = [];
  const seen = new Set();
  for await (const stmt of sqlite3.statements(db, `SELECT id, name, COALESCE(description, ''), created_at, updated_at FROM sessions ORDER BY updated_at DESC, created_at DESC`)) {
    while (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) {
      const v = sqlite3.row(stmt);
      const id = v[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rawName = v[1];
      const name = (rawName && rawName.trim()) ? rawName.trim() : (id === 'default' ? 'Default Session' : 'Untitled Session');
      sessions.push({ id, name, description: v[2], created_at: v[3], updated_at: v[4] });
    }
  }
  return sessions;
}

/**
 * Rename an existing session.
 */
export async function renameSession(sqlite3, db, sessionId, newName) {
  const cleanName = String(newName || '').trim();
  if (!cleanName) throw new Error('Session name cannot be empty');
  for await (const stmt of sqlite3.statements(db, `UPDATE sessions SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)) {
    sqlite3.bind_collection(stmt, [cleanName, sessionId]);
    await sqlite3.step(stmt);
  }
  return { id: sessionId, name: cleanName };
}

/**
 * Delete a session and all its messages, compactions, and logs.
 */
export async function deleteSession(sqlite3, db, sessionId) {
  if (sessionId === 'default') throw new Error('Cannot delete default session');
  for (const table of ['messages', 'compactions', 'turn_changesets', 'turn_ddl_log']) {
    try {
      await execParams(sqlite3, db, `DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
    } catch { /* table might not exist in early migrations */ }
  }
  await execParams(sqlite3, db, `DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

/**
 * Fork a session from a message ID (includes all messages up to and including that ID).
 */
export async function forkSession(sqlite3, db, sourceSessionId, forkPointId, newName = 'Forked Session') {
  const newId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // T2: suppress the cascade while copying. The copied user/tool rows must NOT
  // fire agent_think: (1) v_active_context is pinned to the ACTIVE session, so
  // a forked (non-active) session would build an empty context and ask_llm
  // would throw, failing the fork; (2) even before the view, firing the cascade
  // mid-copy would corrupt the fork with stray assistant rows. (try/finally —
  // a stuck '1' permanently kills the cascade.)
  await setSuppressCascade(sqlite3, db, true);
  try {
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
    // T2: copy compactions whose watermark is at or before the fork point.
    // Watermarks increase monotonically with seq, so this selects a contiguous
    // prefix (seq 0..k); the fork's active context uses the latest such
    // compaction (the view reads max(seq)). Later compactions (watermark >
    // fork point) summarize content the fork doesn't have, so they're excluded.
    //
    // The watermark must be REMAPPED: the message copy above assigns NEW
    // autoincrement ids (messages.id is global across sessions), so the
    // source's watermark_id would point at the wrong rows in the fork. The
    // copy is 1:1 and id-ordered, so the watermark's RANK in the source's
    // copied rows is its rank in the fork's rows. (Every row with id <=
    // watermark is also <= forkPointId, so the rank always exists.)
    const origIds = [];
    for await (const stmt of sqlite3.statements(db, `
      SELECT id FROM messages WHERE session_id = ? AND id <= ? ORDER BY id ASC
    `)) {
      sqlite3.bind_collection(stmt, [sourceSessionId, forkPointId]);
      while (await sqlite3.step(stmt) === SQLITE_ROW) origIds.push(sqlite3.row(stmt)[0]);
    }
    const newIds = [];
    for await (const stmt of sqlite3.statements(db, `
      SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC
    `)) {
      sqlite3.bind_collection(stmt, [newId]);
      while (await sqlite3.step(stmt) === SQLITE_ROW) newIds.push(sqlite3.row(stmt)[0]);
    }
    const compactions = [];
    for await (const stmt of sqlite3.statements(db, `
      SELECT seq, summary, watermark_id, created_at FROM compactions
      WHERE session_id = ? AND watermark_id <= ? ORDER BY seq ASC
    `)) {
      sqlite3.bind_collection(stmt, [sourceSessionId, forkPointId]);
      while (await sqlite3.step(stmt) === SQLITE_ROW) compactions.push(sqlite3.row(stmt));
    }
    for (const [seq, summary, watermarkId, createdAt] of compactions) {
      const rank = origIds.indexOf(watermarkId);
      if (rank === -1) continue; // defensive: watermark row wasn't copied
      const remapped = newIds[rank];
      for await (const stmt of sqlite3.statements(db, `
        INSERT INTO compactions (session_id, seq, summary, watermark_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)) {
        sqlite3.bind_collection(stmt, [newId, seq, summary, remapped, createdAt]);
        await sqlite3.step(stmt);
      }
    }
  } finally {
    await setSuppressCascade(sqlite3, db, false);
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
// T3 & T21: Turn Changeset Capture, Rewind Support & Protected-Tables Boundary
// =====================================================================

const SQLITE_ROW = 100;

/** Quote a SQL identifier (table/column name) safely. */
export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Internal tables that are agent state / audit log / UI state / the changeset
 * machinery itself and must NEVER be captured for rewind, dropped, or
 * corrupted by unauthorized DML.
 */
export const INTERNAL_TABLES = new Set([
  'messages',
  'sessions',
  'session_context',
  'system_config',
  'tools',
  'turn_changesets',
  'turn_ddl_log',
  'compactions',
  'dashboard_cards', // T11: grid = UI state, not data state — no capture triggers,
                     // never rewound, and no data_change events for card CRUD
]);

const INTERNAL_TABLES_LOWER = new Set(
  Array.from(INTERNAL_TABLES).map(t => t.toLowerCase())
);

// Virtual table shadow table patterns (explicit fts/vec/vtab naming)
const EXPLICIT_SHADOW_REGEX = /^(?:(?:fts\d*|vec\d*|rtree).*|.*_(?:fts\d*|vec\d*|vtab))_(?:data|idx|content|docsize|config|segments|segdir|rowids|chunks|index)$/i;

/**
 * Check if a table or view name is a protected system table, internal table,
 * or virtual shadow table.
 *
 * @param {string} name - Table or view name
 * @param {Set<string>} [virtualTableParents] - Optional set of virtual table base names
 * @returns {boolean}
 */
export function isProtectedTable(name, virtualTableParents = null) {
  if (!name || typeof name !== 'string') return false;
  const lower = name.trim().toLowerCase();
  if (INTERNAL_TABLES_LOWER.has(lower)) return true;
  if (lower.startsWith('sqlite_')) return true;
  if (EXPLICIT_SHADOW_REGEX.test(lower)) return true;
  if (virtualTableParents && virtualTableParents.size > 0) {
    for (const parent of virtualTableParents) {
      if (lower.startsWith(parent.toLowerCase() + '_')) {
        const suffix = lower.slice(parent.length + 1);
        if (/^(data|idx|content|docsize|config|segments|segdir|rowids|chunks|index)$/i.test(suffix)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Fetch all virtual table names in the database.
 */
export async function getVirtualTableParents(sqlite3, db) {
  try {
    const rows = await queryAll(sqlite3, db, `
      SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'
    `);
    return new Set(rows.map(([n]) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Backward-compatibility alias for isProtectedTable */
export function isInternalTable(name) {
  return isProtectedTable(name);
}

/**
 * Strip SQL comments (-- and /* * /) and string literals ('...') to make
 * structural syntax inspection and target extraction safe.
 *
 * @param {string} sql - Raw SQL text
 * @returns {string} Cleaned SQL with whitespace preserving structure
 */
export function stripSqlCommentsAndStrings(sql) {
  if (!sql || typeof sql !== 'string') return '';
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    // Line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    // Block comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // String literal '...'
    if (sql[i] === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += " '' ";
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * Unquote a SQL identifier (e.g. "my_table" -> my_table, `col` -> col, [tbl] -> tbl).
 *
 * @param {string} name - Identifier text
 * @returns {string} Unquoted identifier
 */
export function unquoteIdentifier(name) {
  if (!name || typeof name !== 'string') return '';
  const s = name.trim();
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith('`') && s.endsWith('`')) ||
      (s.startsWith('[') && s.endsWith(']'))) {
    return s.slice(1, -1).replace(/""/g, '"').replace(/``/g, '`');
  }
  return s;
}

/**
 * Extract target table names and operation types from a SQL query string.
 * Supports INSERT, REPLACE, UPDATE, DELETE, CREATE, DROP, ALTER, and WITH statements.
 *
 * @param {string} sql - SQL query string
 * @returns {Array<{ name: string, operation: 'dml'|'ddl'|'other', verb: string }>}
 */
export function extractTargetTables(sql) {
  const stripped = stripSqlCommentsAndStrings(sql);
  const statements = stripped.split(';').map(s => s.trim()).filter(Boolean);
  const targets = [];

  const identPattern = '(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[a-zA-Z_][a-zA-Z0-9_]*)';
  const schemaIdentPattern = `(?:${identPattern}\\.)?(${identPattern})`;

  for (const stmt of statements) {
    const s = stmt.trim();
    if (!s) continue;

    // DDL: CREATE TABLE / VIEW / INDEX
    let m = s.match(new RegExp(`^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?(?:UNIQUE\\s+)?(?:TABLE|VIEW|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'ddl', verb: 'CREATE' });
      continue;
    }

    // DDL: DROP TABLE / VIEW / INDEX
    m = s.match(new RegExp(`^DROP\\s+(?:TABLE|VIEW|INDEX)\\s+(?:IF\\s+EXISTS\\s+)?${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'ddl', verb: 'DROP' });
      continue;
    }

    // DDL: ALTER TABLE
    m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'ddl', verb: 'ALTER' });
      continue;
    }

    // DML: INSERT / REPLACE INTO
    m = s.match(new RegExp(`\\b(?:INSERT(?:\\s+OR\\s+(?:REPLACE|IGNORE|ROLLBACK|ABORT|FAIL))?|REPLACE)\\s+INTO\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'dml', verb: 'INSERT' });
      continue;
    }

    // DML: UPDATE
    m = s.match(new RegExp(`\\bUPDATE(?:\\s+OR\\s+(?:REPLACE|IGNORE|ROLLBACK|ABORT|FAIL))?\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'dml', verb: 'UPDATE' });
      continue;
    }

    // DML: DELETE FROM
    m = s.match(new RegExp(`\\bDELETE\\s+FROM\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'dml', verb: 'DELETE' });
      continue;
    }
  }

  return targets;
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
  if (isProtectedTable(tableName)) return;

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
  const vParents = await getVirtualTableParents(sqlite3, db);
  const tables = await queryAll(sqlite3, db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  for (const [name] of tables) {
    if (isProtectedTable(name, vParents)) {
      // Protected and internal tables must have NO capture triggers. Drop any stale ones.
      await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS cap_${name}_ins`);
      await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS cap_${name}_upd`);
      await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS cap_${name}_del`);
      continue;
    }
    await ensureCaptureTriggers(sqlite3, db, name);
  }
}

/**
 * T21: Boot-time invariant assertion:
 * 1. Zero capture triggers (cap_%_ins, cap_%_upd, cap_%_del) exist on ANY protected table.
 * 2. Every non-protected user data table has the 3 required capture triggers.
 *
 * Throws an error on invariant violation.
 */
export async function assertProtectedTablesInvariant(sqlite3, db) {
  const vParents = await getVirtualTableParents(sqlite3, db);

  // 1. Check all triggers on protected tables
  const triggerRows = await queryAll(sqlite3, db, `
    SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_%'
  `);
  for (const [trigName, tblName] of triggerRows) {
    if (isProtectedTable(tblName, vParents)) {
      throw new Error(`[invariant violation] Stale capture trigger "${trigName}" found on protected table "${tblName}".`);
    }
  }

  // 2. Check all user data tables have capture triggers
  const tableRows = await queryAll(sqlite3, db, `
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `);
  for (const [tblName] of tableRows) {
    if (isProtectedTable(tblName, vParents)) continue;
    const requiredTriggers = [`cap_${tblName}_ins`, `cap_${tblName}_upd`, `cap_${tblName}_del`];
    const existing = await queryAll(sqlite3, db, `
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?
    `, [tblName]);
    const existingSet = new Set(existing.map(([n]) => n));
    for (const req of requiredTriggers) {
      if (!existingSet.has(req)) {
        throw new Error(`[invariant violation] Missing required capture trigger "${req}" on data table "${tblName}".`);
      }
    }
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

/**
 * Migration: existing databases have `row <= 2` CHECK constraints on `dashboard_cards`.
 * Migrate to unlimited row expansion so cards can be placed in lower grid zones.
 */
export async function migrateDashboardCardsTable(sqlite3, db) {
  try {
    const rows = await queryAll(sqlite3, db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_cards'`);
    if (!rows.length || !rows[0][0]) return;
    const currentSql = rows[0][0];
    if (currentSql.includes('row <= 2') || currentSql.includes('row_span <= 3')) {
      console.warn('[schema] dashboard_cards has 3x3 CHECK constraint — migrating to expandable grid');
      await sqlite3.exec(db, `
        CREATE TABLE IF NOT EXISTS dashboard_cards_new (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            sql        TEXT NOT NULL,
            row        INTEGER NOT NULL DEFAULT 0 CHECK(row >= 0),
            col        INTEGER NOT NULL DEFAULT 0 CHECK(col >= 0 AND col <= 2),
            row_span   INTEGER NOT NULL DEFAULT 1 CHECK(row_span >= 1),
            col_span   INTEGER NOT NULL DEFAULT 1 CHECK(col_span >= 1 AND col_span <= 3),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO dashboard_cards_new (id, title, sql, row, col, row_span, col_span, created_at, updated_at)
          SELECT id, title, sql, row, col, row_span, col_span, created_at, updated_at FROM dashboard_cards;
        DROP TABLE dashboard_cards;
        ALTER TABLE dashboard_cards_new RENAME TO dashboard_cards;
      `);
    }
  } catch (e) {
    console.warn('[schema] migrateDashboardCardsTable failed (non-fatal):', e.message);
  }
}
