/**
 * Database Schema — the agent's brain.
 *
 * Pure-SQL trigger cascade (ReAct loop):
 *   user INSERT → agent_think → assistant INSERT → execute_tool → tool_result INSERT → agent_think → …
 *
 * Requires wa-sqlite JSPI build for async UDFs in triggers.
 */
export const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS tools (
    name   TEXT PRIMARY KEY,
    schema TEXT NOT NULL
);

INSERT OR IGNORE INTO tools (name, schema) VALUES
  ('execute_sql',
    '{"type":"function","function":{"name":"execute_sql","description":"Execute a read-only SQL query against the SQLite database. Returns JSON-formatted rows.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The SQL SELECT query to execute"}},"required":["query"]}}}');

CREATE TABLE IF NOT EXISTS agent_memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool_result')),
    content     TEXT,
    tool_calls  TEXT,
    tool_call_id TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO agent_memory (id, role, content)
VALUES (0, 'system', (SELECT value FROM system_config WHERE key = 'system_prompt'));

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

-- TRIGGER 1: Thinking Phase (fires on user/tool_result → calls ask_llm → inserts assistant)
CREATE TRIGGER IF NOT EXISTS agent_think
AFTER INSERT ON agent_memory
WHEN NEW.role IN ('user', 'tool_result')
BEGIN
    INSERT INTO agent_memory (role, content, tool_calls)
    SELECT 'assistant',
        json_extract(llm_response, '$.content'),
        json_extract(llm_response, '$.tool_calls')
    FROM (SELECT ask_llm(
        (SELECT json_group_array(json_object(
            'role', CASE WHEN role = 'tool_result' THEN 'tool' ELSE role END,
            'content', COALESCE(content, ''),
            'tool_calls', CASE WHEN role = 'assistant' AND tool_calls IS NOT NULL THEN json(tool_calls) ELSE NULL END,
            'tool_call_id', CASE WHEN role = 'tool_result' AND tool_call_id IS NOT NULL THEN tool_call_id ELSE NULL END
        )) FROM agent_memory ORDER BY id ASC),
        (SELECT json_group_array(json(schema)) FROM tools)
    ) AS llm_response);
END;

-- TRIGGER 2: Acting Phase (fires on assistant with tool_calls → executes tool → inserts result)
CREATE TRIGGER IF NOT EXISTS execute_tool
AFTER INSERT ON agent_memory
WHEN NEW.role = 'assistant' AND NEW.tool_calls IS NOT NULL AND json_array_length(NEW.tool_calls) > 0
BEGIN
    INSERT INTO agent_memory (role, content, tool_call_id)
    SELECT 'tool_result',
        CASE json_extract(NEW.tool_calls, '$[0].function.name')
            WHEN 'execute_sql' THEN
                run_dynamic_sql(COALESCE(
                    json_extract(NEW.tool_calls, '$[0].function.arguments.query'),
                    json_extract(json_extract(NEW.tool_calls, '$[0].function.arguments'), '$.query')))
            ELSE json_object('error', 'Unknown tool: ' || json_extract(NEW.tool_calls, '$[0].function.name'))
        END,
        json_extract(NEW.tool_calls, '$[0].id');
END;
`;
