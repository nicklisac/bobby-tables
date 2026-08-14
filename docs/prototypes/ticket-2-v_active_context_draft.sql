-- =====================================================================
-- TICKET 2 DRAFT — v_active_context (windowed declutter view)
-- Status: PROTOTYPE — a concrete take to react to, not shippable yet
--
-- Purpose: feed the agent_think trigger a token-efficient context while
--          keeping `messages` 100% untampered (full history stays in the
--          table; the view is a lossy *projection*, never a mutation).
--
-- Design constraints found while drafting:
--   C1. PAIR-SAFETY. formatMessages() (harness.js) passes tool_call_id /
--       tool_calls straight to an OpenAI-compatible chat API, which
--       rejects orphaned tool_call_ids: a `tool` row's tool_call_id must
--       match a preceding assistant tool_calls entry. => Compression must
--       never strip an assistant's tool_calls while keeping its tool
--       result. Draft keeps a tool_calls *skeleton* (id + name, args
--       dropped) for old pairs.
--   C2. VIEWS TAKE NO PARAMETERS. The view pins to the active session via
--       session_context — safe today because the ReAct cascade only ever
--       runs on the active session. If we ever need per-session context
--       outside the cascade (fork previews, multi-session dashboards),
--       promote this to a UDF: active_context(session_id).
--
-- OPEN DECISIONS (the grilling frontier — see chat):
--   Q1. Window unit & size — draft: last 20 TURNS (turn = one user
--       message + everything until the next user message). Mirrors
--       Ticket 3's 20-turn rewind window. Alternative: token-budget
--       window (walk back from the tail until ~N chars, ~4 chars/token).
--   Q2. Old tool-output shape — draft: head-truncate at 200 chars +
--       '…[truncated]'. Alternatives: (a) structured stub
--       {"truncated":true,"chars":12345,"head":"…"}, (b) one-line
--       marker '[tool result omitted]'.
--   Q3. Old assistant reasoning — draft: keep full (it is the chain of
--       thought, usually short). Alternative: compress like tool output.
--   Q4. Old tool_calls skeleton — draft: keep id + name, drop arguments
--       (arguments often embed full SQL text and bloat the context).
-- =====================================================================

CREATE VIEW IF NOT EXISTS v_active_context AS
WITH active AS (
    -- C2: pinned to the active session
    SELECT value AS session_id
    FROM session_context
    WHERE key = 'active_session_id'
),
tagged AS (
    SELECT
        m.id,
        m.session_id,
        m.role,
        m.content,
        m.tool_calls,
        m.tool_call_id,
        -- Q1: a turn starts at every user message (system rows ride turn 0)
        SUM(m.role = 'user') OVER (
            PARTITION BY m.session_id
            ORDER BY m.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS turn_no
    FROM messages m
    CROSS JOIN active a
    WHERE m.session_id = a.session_id
),
windowed AS (
    SELECT
        t.*,
        MAX(t.turn_no) OVER (PARTITION BY t.session_id) AS last_turn
    FROM tagged t
),
skeletons AS (
    -- C1/Q4: id + name only, so old tool_call_ids stay resolvable
    SELECT
        w.id,
        (
            SELECT json_group_array(json_object(
                'id',       json_extract(tc.value, '$.id'),
                'type',     'function',
                'function', json_object('name', json_extract(tc.value, '$.function.name'))
            ))
            FROM json_each(w.tool_calls) tc
        ) AS skeleton
    FROM windowed w
    WHERE w.role = 'assistant'
      AND w.tool_calls IS NOT NULL
)
SELECT
    w.id,
    w.role,
    CASE
        WHEN w.role = 'system'                          THEN w.content
        WHEN w.last_turn - w.turn_no < 20               THEN w.content   -- Q1: recent window, full fidelity
        WHEN w.role = 'tool'
            THEN substr(w.content, 1, 200) || ' …[truncated]'           -- Q2
        WHEN w.role = 'user'                            THEN w.content   -- intent is short; keep
        ELSE w.content                                               -- Q3: old assistant reasoning kept full
    END AS content,
    CASE
        WHEN w.role <> 'assistant'                      THEN NULL
        WHEN w.last_turn - w.turn_no < 20               THEN w.tool_calls
        ELSE COALESCE(s.skeleton, w.tool_calls)         -- Q4
    END AS tool_calls,
    w.tool_call_id
FROM windowed w
LEFT JOIN skeletons s ON s.id = w.id
ORDER BY w.id ASC;

-- =====================================================================
-- WIRING (not part of the view): the agent_think trigger's context
-- subquery switches from `FROM messages` to `FROM v_active_context`.
-- The view emits the same columns the trigger's json_object() reads,
-- so the trigger body changes in exactly one place:
--
--   FROM messages WHERE session_id = NEW.session_id ORDER BY id ASC
--   FROM v_active_context WHERE session_id = NEW.session_id ORDER BY id ASC
--
-- (The WHERE is belt-and-braces: the view is already session-pinned.)
-- =====================================================================
