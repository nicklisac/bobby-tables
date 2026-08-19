# Web SQL Agent — Bug Log

This document tracks known issues, edge cases, and improvements to be addressed in upcoming sessions.

---

### BUG-001: Canvas Grid Placement Beyond Initial 3×3 Grid
- **Status**: Resolved
- **Reported**: Ticket 8 / UI Milestone
- **Component**: `src/schema.js`, `src/grid-ui.js`, `src/harness.js`
- **Description**: Users could not place dashboard cards into grid cells below the initial 3×3 grid area.
- **Root Cause**: The SQLite `dashboard_cards` schema had `CHECK(row >= 0 AND row <= 2)` and `CHECK(row_span <= 3)` constraints from the original fixed 3×3 design.
- **Resolution**: Migrated `dashboard_cards` schema to `CHECK(row >= 0)` (and `CHECK(row_span >= 1)`) with automatic runtime schema migration (`migrateDashboardCardsTable`) during boot.

---

### BUG-002: Inability to Select / Copy Text Inside Draggable Chat Assets
- **Status**: Open / Backlogged
- **Reported**: Ticket 8 / UI Milestone
- **Component**: `src/main.js` (`.draggable-chat-asset`), `src/styles.css`
- **Description**: Users cannot highlight and copy text or table values from tool results and messages in the chat pane if the element is marked as draggable.
- **Root Cause**: The entire tool result container has `draggable="true"` set at the wrapper element level, causing browser click-and-drag mouse actions to initiate HTML5 Drag and Drop instead of text selection.
- **Proposed Fix**: Separate the drag handle (e.g., dedicate the `.drag-pin-badge` or an explicit drag grip icon as the drag source) and/or disable drag when selecting text inside content elements, ensuring standard user text selection and clipboard copying works unimpeded.

---

### BUG-003: Non-Resizable Table Columns Across Application UI
- **Status**: Open / Backlogged
- **Reported**: Ticket 8 / UI Milestone
- **Component**: `src/main.js`, `src/grid-ui.js`, `src/explorer-ui.js`, `src/styles.css`
- **Description**: Tables rendered across the application (chat tool query results, scratchpad tables, DB Explorer sample data viewer, and dashboard card tables) have static column widths and cannot be resized by the user.
- **Proposed Fix**: Implement column drag-resizing handlers (`<th class="resizable-th"><div class="col-resizer"></div></th>`) allowing users to drag header dividers to expand or shrink individual column widths smoothly.

---

### BUG-004: Chat Input Enabled When LLM Provider Is Not Configured
- **Status**: Resolved
- **Reported**: User Feedback
- **Component**: `src/main.js`, `index.html`, `src/styles.css`
- **Description**: When an LLM provider is not set or configured, the user could still type and attempt to send chat messages, leading to failed requests or unhandled errors. Users should be directed to the provider settings/list before they try to chat.
- **Root Cause**: Chat input and submit controls were enabled on initialization without validating whether an active LLM provider, API key, or valid endpoint has been configured in local storage / settings.
- **Resolution**: Added `isProviderConfigured()` check, glowing amber animation (`.config-glow`) to the `⚙ Config` button when unconfigured, onboarding welcome card with a direct setup action in empty chat sessions, and submission guards that prompt the user to configure their LLM provider while preserving direct SQL (`!SQL` / `!!SQL`) access.

---

### BUG-005: Limited LLM Provider Selection (Missing Major Industry Providers)
- **Status**: Open / Backlogged
- **Reported**: User Feedback
- **Component**: `src/harness.js`, `src/main.js`, `index.html`
- **Description**: The application currently only provides options for generic OpenAI-compatible endpoints and Google Gemini. Support is needed for the major LLM providers out of the box (e.g., Anthropic Claude, OpenAI official, Google Gemini, Groq, Mistral, OpenRouter, and local Ollama/LM Studio presets).
- **Root Cause**: The configuration UI (`#config-provider`) and HTTP transport in `src/harness.js` only implement request/response framing for generic OpenAI-compatible completions and Gemini REST APIs.
- **Proposed Fix**: Expand the provider list and transport layer to support major LLM providers natively, including Anthropic Claude (Messages API format), OpenAI direct, Groq, Mistral, OpenRouter, and local providers with preset endpoints and default model selections.

---

### BUG-006: Missing Drop-Target Grid Cell Highlighting When Dragging From Chat Pane
- **Status**: Open / Backlogged
- **Reported**: User Feedback
- **Component**: `src/main.js`, `src/grid-ui.js` (`updateDragHighlight`, `activeDragData`), `src/styles.css`
- **Description**: When dragging an asset (table, web search, URL preview) from the chat pane onto the dashboard grid canvas, the target grid cells where the card will land do not highlight (`.drag-target-hover`).
- **Root Cause**: `updateDragHighlight()` in `src/grid-ui.js` relies on an internal `activeDragData` variable to compute target cell bounds and spans. While internal card moves/resizes set this variable, the chat asset `dragstart` listener in `src/main.js` only sets `e.dataTransfer.setData()`. Because browsers disallow reading `dataTransfer.getData()` during `dragover` for security reasons, `activeDragData` remains null and `updateDragHighlight()` immediately aborts and clears cell highlights.
- **Proposed Fix**: Expose a shared drag state helper (e.g., `gridUi.setActiveDragData(data)`) and call it from the chat asset `dragstart` / `dragend` handlers in `src/main.js` so `updateDragHighlight()` accurately renders the target cell bounding box for chat assets during dragover.

---

### BUG-007: Multiple Duplicate Dashboard Cards Created on Chat Asset Drop
- **Status**: Open / Backlogged
- **Reported**: User Feedback
- **Component**: `src/grid-ui.js` (`renderGrid`, `onCellDrop`)
- **Description**: Dragging and dropping an asset from the chat pane onto the dashboard canvas grid sometimes causes the card to be duplicated vertically multiple times (e.g., 2 to 4 duplicate cards created in SQLite).
- **Root Cause**: In `renderGrid()`, `drop` event listeners are attached individually to every `.grid-cell` element AND to the parent `#dashboard-grid` container. When dropping an item, the drop event triggers concurrent `onCellDrop()` executions that each call `addCard()` / `materializeToolResult()`.
- **Proposed Fix**: Unify the drop listener to the grid container only (or add `e.stopPropagation()` and a drop in-flight debounce lock in `onCellDrop`) to ensure `addCard()` executes strictly once per drop action.

---

### BUG-008: Silent Data Loss — Statement Commits Write Zero Pages to IDB (JSPI Re-entrancy)
 - **Status**: **Resolved & verified** — traced probe 12/12 clean (was ~50% flaky pre-fix); full 7/7 suite green, run twice. Investigation record (archived): **`docs/archive/BUG-008_INVESTIGATION.md`** (§12 = the definitive record).
 - **Reported**: Ticket 26.1 (guardrails harness) — persistence suite red on clean `main`
 - **Component**: **`src/harness.js` (the decisive fix — re-entrant serialization gate, §below item 8)**, plus `vendor/wa-sqlite-jspi/sqlite-api.js` (floating `maybeFinalize` in `sqlite3.statements` generator & prepare on empty `zTail`), `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js` (`jLock(SHARED)` read-only default mode, inactive retry `#txComplete` deadlock, and `sync()` write durability await), `src/schema.js` (protected tables `_` & `_clean`), `src/main.js` (`btn-new-session` disable guard, boot UI lifecycle await, awaited explorer render, lazy schema refresh).
- **Description**: A statement that "commits" successfully could write **zero pages** to the IDB-backed VFS. The row existed only in the WASM page cache — same-connection reads (dropdown, `SELECT`) saw it, but after a reload it was gone. In the worst case the interleaving corrupted the on-disk image: `SQLiteError: file is not a database` on the next boot.
- **Root Cause & Resolutions**:
  1. **Vendor Generator Finalize Await (`sqlite-api.js`)**: Made `maybeFinalize()` an `async` function and `await`ed it both inside the `do...while` loop and in `finally`. Prevents Statement $N-1$ async teardown (`jUnlock` $\rightarrow$ IDB sync) from racing Statement $N$ `prepare`/`step`.
  2. **Empty `zTail` Pre-check (`sqlite-api.js`)**: Skipped calling `sqlite3_prepare_v3` when remaining SQL string contains only whitespace/null terminator. Prevents acquiring stranded `SHARED` locks on empty SQL tails.
  3. **`jLock(SHARED)` Read-Only Metadata Mode (`IDBBatchAtomicVFS.js`)**: Defaulted `jLock(SHARED)` metadata queries to `'ro'` mode, only escalating to `'rw'` if `pendingVersion` is present (crash recovery).
  4. **Microtask-Deadlock-Free Retry (`IDBBatchAtomicVFS.js`)**: In `IDBContext.#q`, only awaited `#txComplete` if transitioning from an active `readwrite` transaction, preventing deadlocks on Chrome microtask yields during readonly / inactive retries.
  5. **Durability Guarantee on Sync (`IDBBatchAtomicVFS.js`)**: `IDBContext.prototype.sync` awaits `#txComplete` whenever `this.#txPending` contains an active `readwrite` transaction, guaranteeing all dirty blocks are written to IDB before unlocking.
  6. **Protected Table Naming (`src/schema.js`)**: Extended `isProtectedTable` to cover all tables starting with `_` or ending with `_clean`.
   7. **Boot Lifecycle & UI Gating (`src/main.js`, `tests/helpers.mjs`)**: `bootAgent()` properly awaits `initGridUi()` and `initExplorerUi()` before setting `window.__agent.ready = true` and enabling input controls.
   8. **Re-entrant serialization gate (`src/harness.js`) — the decisive fix.** Items 1–7 fixed the *data-loss* half (floating finalize, stranded lock on empty SQL, durability). The *hang* half remained: SQLite's C core is not re-entrant on one `sqlite3*` handle (no pthreads ⇒ internal mutexes are no-ops), so two **independent** queries re-entering wasm concurrently (JSPI) clobber the Pager/B-tree/page-cache C state; the first never reaches `jUnlock(NONE)`, the second's exclusive `access` Web Lock queues behind it forever → hang. The gate serializes **independent** queries one-at-a-time (`entryQueue`, synchronous tail-swap, acquired on the generator's first `next()`, released in its `finally`) while allowing **nested** (UDF) queries. A query is nested iff issued while a UDF is executing (`udfDepth > 0`, tracked by wrapping `create_function` with an async `udfDepth++/finally--`). Classifying by `stepDepth` was insufficient — a top-level catalog *step* in flight misclassifies an independent query as nested and lets it clobber (the ~25% residual). A non-fatal warn trips on parallel nested queries.
  - **Verification**: Traced probe `tests/probes/probe_toolcall_traced.mjs` **12/12 clean** (was ~50% flaky pre-fix, ~25% after items 1–7 + first gate version). Full 7/7 suite green **twice** (16.1s / 15.9s); tool-call test 1.3s. `vendor/wa-sqlite-jspi/WebLocksMixin.js` was **not** modified (a lock-dedup idea was reviewed and rejected — it drops the lock early and doesn't address C-state; see investigation §12.5).

### BUG-009: Tool-call assistant message renders as `[empty]` (streaming vs. re-render mismatch)
- **Status**: **Closed** (fixed & verified 2026-08-19; regression guard `tests/specs/bug-009-toolcall-chip.spec.mjs`).
- **Reported**: Manual test on the running server after the BUG-008 fix (first time the tool-call path was reachable).
- **Component**: `src/chat-render.js` (`renderMessages` per-message render + new `renderToolCallChip`), `src/styles.css` (`.toolcall-chip`).
- **Description**: A tool-call turn writes two rows — an **assistant** row (`content = ''`, `tool_calls = <call>`) and a **tool** row (`content = <result>`). The chat renders the assistant row as `[empty]` because `renderMessages()` does `div.textContent = content || '[empty]'` and never reads `tool_calls`. The tool *result* (a table) renders fine as its own `tool` row.
- **Observed behavior (user):** during the turn the (soon-to-be-empty) assistant bubble **fills up with the tool-call code** — i.e. a live/streaming path is watching the model response and painting it (raw tool-call payload included). When the turn finishes, the tool-call trigger fires, runs the tool, and the post-turn `renderMessages()` re-render (the "blink") replaces that bubble with `[empty]`. So the streaming render and the DB re-render disagree about what an assistant-with-tool-call row should show.
- **Expected**: the assistant row should show the tool call (e.g. a "⚙ execute_sql — `SELECT …`" chip, or a collapsible call) instead of `[empty]`, so the turn reads *user → [tool call] → [tool result] → assistant answer*. Also reconcile the streaming bubble with the re-render so the bubble doesn't visibly "fill then clear".
- **Resolution**: `renderMessages()` now reads `tool_calls` on assistant rows. A row that requested a tool (empty content + a `tool_calls` array) renders a **collapsible chip** (`.toolcall-chip`): the tool name + a one-line summary (the SQL / URL / table name) are always visible, and clicking expands the full arguments in a `<pre>`. A pure tool-call row gets the `toolcall-only` class (no assistant-bubble chrome); a row with both content and a call keeps the bubble + chip. The tool RESULT still renders as its own row below, so the turn reads *user → [tool call chip] → [tool result] → answer*. The streaming path already removed the empty bubble (it shows the live tool indicator), so the re-render now agrees with it. `arguments` is normalized (object or JSON-string form).
 - **Notes**: Pre-existing (not introduced by the BUG-008 work — the per-message render was untouched). Only became visible now that BUG-008 no longer breaks the tool-call path before this point.

---

### BUG-013: Rewind Doesn't Rewind — Chat Conversation Not Cleared, Agent DDL Turns Never Undone
- **Status**: **Closed** (fixed & verified 2026-08-19; regression guard `tests/specs/t3-rewind.spec.mjs`)
- **Reported**: User feedback — "When I rewind the chats do not rewind/get removed from the chat window up to the rewind point."
- **Component**: `src/schema.js` (views + `messages.rewound` column), `src/rewind.js` (flag + replay scope), `src/harness.js` (agent DDL logging), `src/chat-render.js` (pane query), `src/compaction.js` (context estimator), `src/scratchpad.js` (nested-scope DDL)
- **Description**: Two distinct defects behind one user-facing symptom ("rewind doesn't rewind"):
  1. **Chat not rewound.** Rewind was *data-only* by design (T3): it replayed inverse DML/DDL against the database but left the `messages` conversation untouched, so the chat pane still showed every turn at/after the rewind point. The user expected the conversation to rewind too.
  2. **Agent DDL turns never undone.** The agent's `execute_sql` DDL path logged `turn_ddl_log` rows with `table_name = NULL` and no drop pre-image (both hardcoded `null`), so the rewind's DDL-inverse replay ran `DROP TABLE "null"` / a no-op `CREATE` — an agent `CREATE TABLE` turn left the table in place after rewind.
- **Root Cause**:
  1. T3's locked design was "data only — `messages` is an immutable audit log; a system marker row is appended". No mechanism existed to hide the rewound conversation from the pane or the agent's LLM context.
  2. The agent DDL path in `run_dynamic_sql` (harness.js) pre-dated the per-statement table-name extraction that the scratchpad path (`scratchpad.js`) already had. It logged one coarse row per statement batch with `tableName`/`preImage` left `null`.
- **Resolution**:
  1. **Chat rewind (flag + hide, non-destructive).** New `messages.rewound INTEGER DEFAULT 0` column (SCHEMA_SQL + `migrateMessagesTable`). On a real-turn rewind, every row `id >= beforeTurnId` is flagged `rewound = 1` (never deleted — the audit log survives). Flagged rows are hidden from: the chat pane query (`chat-render.js`), the agent's `v_active_context` / `v_turn_boundaries` / `v_tool_call_queries` views (`schema.js`), the compaction `toSummarize` + anchor queries (`compaction.js`), and the orphan-pair repair. `forkSession` copies the column. The marker row is still appended.
  2. **Agent DDL now logged correctly.** `extractDdlTableName` + `captureDropPreImage` moved from `scratchpad.js` to `schema.js` (exported, shared). The agent DDL path in `harness.js` now logs **per statement** (before each `step`), with the real `table_name` and a drop pre-image for `DROP TABLE`, so the DDL-inverse replay actually drops/recreates the right table. `getChangesetSummary` now counts DDL so the confirm dialog doesn't claim "no data changes".
  3. **Consistency:** a real-turn rewind now also undoes scratchpad commands issued *after* the point (their bubbles get flagged, so their data must be undone too) — the replay + changeset-consumption scope is `(turn_id >= N OR turn_id <= -N)`.
- **Verification**: `tests/specs/t3-rewind.spec.mjs` (3 tests): agent `CREATE TABLE` → rewind → table gone + chat flagged + context cleared + dialog counts DDL; scratchpad `DROP TABLE` (with rows) → rewind → table + rows restored from pre-image; real-turn rewind undoes scratchpad commands issued after the point. Full suite 26/26 green.

---

### BUG-014: Scratchpad DDL Deadlock — `!!CREATE` / `!!DROP` Hang (BUG-008 Gate Regression)
- **Status**: **Closed** (fixed & verified 2026-08-19; exercised by `tests/specs/t3-rewind.spec.mjs` test 2)
- **Reported**: Found while fixing BUG-013 (the scratchpad DDL path is the working DROP path and hung during verification).
- **Component**: `src/scratchpad.js` (`execScratchSql`), `src/harness.js` (serialization gate nested-scope API)
- **Description**: Running a DDL command through the scratchpad (`!!CREATE TABLE …`, `!!DROP TABLE …`) hung forever — the DDL never executed and the turn never completed.
- **Root Cause**: A regression from the BUG-008 re-entrant serialization gate (T26.1). The gate classifies a query as *nested* (allowed to run inline) iff it is issued while a UDF is executing (`udfDepth > 0`). The scratchpad DDL path's inner queries (`logDDL`, `captureDropPreImage`'s pre-image SELECT) were issued from *inside the same generator* that holds the entry slot — not from a UDF — so they were misclassified as *independent* and queued behind their own generator's entry slot → self-deadlock.
- **Resolution**: Added a **manual nested-scope** API to the gate in `harness.js` (`agentApi.beginNestedScope()` / `agentApi.endNestedScope()`, backed by a `manualDepth` counter). `execScratchSql` enters the scope after its first `next()` (once the generator has acquired the entry slot), so its inner DDL-logging / pre-image queries are classified nested (`isNested = udfDepth > 0 || manualDepth > 0`) and run inline instead of queueing behind themselves. See `docs/TRANSACTION_RULES.md` §6.
- **Verification**: `tests/specs/t3-rewind.spec.mjs` test 2 (scratchpad `DROP TABLE` with rows → rewind → restored) exercises the scratchpad DDL path and passes; full suite 26/26 green.

---

### BUG-015: Agent `execute_sql` Cannot `DROP TABLE` in the UDF Cascade (SQLITE_LOCKED_TABLE)
- **Status**: **Open** — pre-existing, **not** fixed (out of scope for the BUG-013 work). Tracked here so it is not lost.
- **Reported**: Found while fixing BUG-013 (probing whether the agent DDL path could be exercised with a real `DROP TABLE`).
- **Component**: `src/harness.js` (`run_dynamic_sql` UDF), `vendor/wa-sqlite-jspi/` (SQLite C core + JSPI VFS)
- **Description**: When the agent's `execute_sql` tool runs `DROP TABLE` inside the ReAct UDF cascade, SQLite fails with `SQLITE_LOCKED_TABLE` and the drop never happens. `CREATE TABLE` and `ALTER TABLE` work in the same path; only `DROP TABLE` fails.
- **Root Cause (hypothesis, unverified)**: A schema change (`DROP TABLE`) nested inside a suspended write statement (the JSPI UDF is mid-cascade, holding a write transaction) is rejected by the SQLite C core. Fails even with zero inner queries, so it is **not** the BUG-014 gate misclassification. The scratchpad path (top-level, not nested in a UDF) drops tables fine — which is why BUG-013's DROP-rewind is verified via the scratchpad path.
- **Impact**: Agent-initiated `DROP TABLE` turns never actually drop the table (the tool returns an error). DML + `CREATE` / `ALTER` are unaffected. The user can still drop tables via the scratchpad (`!!DROP TABLE …`).
- **Proposed Fix**: Investigate whether the agent DDL path should (a) run DDL outside the UDF suspension (a dedicated top-level DDL tool/endpoint), (b) restructure the savepoint / transaction nesting so the drop is not "locked", or (c) accept the limitation and document that agent DDL is create/alter-only. Needs a controlled repro probe before any fix (per the T26 BUG-012 lesson: don't declare fixed without the exact repro).

---

### BUG-016: Gemini Provider Could Be Routed to a Stale / Wrong Endpoint URL
- **Status**: **Closed** (fixed 2026-08-19 — landed via a split T3 session).
- **Reported**: Split T3 session (config / endpoint hardening).
- **Component**: `src/harness.js` (`resolveEndpointUrl`), `src/main.js` (`saveConfig`)
- **Description**: The config UI hides the URL field for the "Google Gemini API" provider, but a value can still be present in the stored config (e.g. a leftover local Ollama / LM Studio endpoint from a previous "OpenAI Compatible" setup). `resolveEndpointUrl` used to return `url || <fixed Google endpoint>`, so that stale URL would **silently route Gemini turns to the wrong model / endpoint**.
- **Resolution**: The `gemini` provider now **always** uses the fixed Google endpoint (`resolveEndpointUrl` ignores any stored `url` for it), and `saveConfig` clears the URL to `''` when the provider is `gemini` (other providers still persist the URL field). Custom endpoints remain the "OpenAI Compatible" provider's job.

---

### Numbering note (BUG-010 / 011 / 012)
BUG-010, BUG-011, and BUG-012 are the **Ticket 26 debugging-session bugs** (per-boot `DROP`+`RENAME` session migration; double-boot VFS corruption; the no-op commit that writes zero pages to IDB). They are tracked in `docs/archive/RETROSPECTIVE_TICKET_26.md` and `docs/TRANSACTION_RULES.md` (§5, §6) and referenced by the `persistence` / `boot-idempotency` / `vfs-contract` specs. Their `BUG_LOG.md` entries were drafted during the `sql-refactor` re-scope but stashed (see retrospective §5) and not merged, so this log jumps from BUG-009 to BUG-013. New entries continue from BUG-013 to avoid colliding with the reserved numbers.


