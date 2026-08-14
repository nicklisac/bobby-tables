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
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast session-scoped queries
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);

-- Seed system message for default session
INSERT OR IGNORE INTO messages (id, session_id, role, content)
VALUES (0, 'default', 'system', (SELECT value FROM system_config WHERE key = 'system_prompt'));

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
-- 6. Migration: agent_memory → messages (idempotent)
-- =====================================================================
-- If legacy agent_memory exists, migrate its data into messages then drop it
INSERT OR IGNORE INTO messages (id, session_id, role, content, tool_calls, tool_call_id, created_at)
SELECT
    id,
    'default' AS session_id,
    CASE WHEN role = 'tool_result' THEN 'tool' ELSE role END,
    content,
    tool_calls,
    tool_call_id,
    created_at
FROM agent_memory
WHERE id > 0;  -- skip id=0 which is already seeded above

-- Old triggers are dropped after new ones are created (IF NOT EXISTS prevents conflict)

-- =====================================================================
-- 7. TRIGGER 1: Thinking Phase (session-scoped)
--    Fires when user or tool message is inserted into the active session.
--    Calls ask_llm with session-scoped context → inserts assistant response.
-- =====================================================================
CREATE TRIGGER IF NOT EXISTS agent_think
AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'tool')
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
            -- Build session-scoped message context
            (SELECT json_group_array(json_object(
                'role', CASE WHEN role = 'tool' THEN 'tool' ELSE role END,
                'content', COALESCE(content, ''),
                'tool_calls', CASE WHEN role = 'assistant' AND tool_calls IS NOT NULL THEN json(tool_calls) ELSE NULL END,
                'tool_call_id', CASE WHEN role = 'tool' AND tool_call_id IS NOT NULL THEN tool_call_id ELSE NULL END
            )) FROM messages WHERE session_id = NEW.session_id ORDER BY id ASC),
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
    INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, prompt_tokens, completion_tokens, created_at)
    SELECT ?, role, content, tool_calls, tool_call_id, prompt_tokens, completion_tokens, created_at
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
