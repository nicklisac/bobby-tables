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
- **Status**: **Open** — not started. Cosmetic (no data loss; the call + result are both persisted and the result renders).
- **Reported**: Manual test on the running server after the BUG-008 fix (first time the tool-call path was reachable).
- **Component**: `src/main.js` (`renderMessages`, per-message render ~line 749).
- **Description**: A tool-call turn writes two rows — an **assistant** row (`content = ''`, `tool_calls = <call>`) and a **tool** row (`content = <result>`). The chat renders the assistant row as `[empty]` because `renderMessages()` does `div.textContent = content || '[empty]'` and never reads `tool_calls`. The tool *result* (a table) renders fine as its own `tool` row.
- **Observed behavior (user):** during the turn the (soon-to-be-empty) assistant bubble **fills up with the tool-call code** — i.e. a live/streaming path is watching the model response and painting it (raw tool-call payload included). When the turn finishes, the tool-call trigger fires, runs the tool, and the post-turn `renderMessages()` re-render (the "blink") replaces that bubble with `[empty]`. So the streaming render and the DB re-render disagree about what an assistant-with-tool-call row should show.
- **Expected**: the assistant row should show the tool call (e.g. a "⚙ execute_sql — `SELECT …`" chip, or a collapsible call) instead of `[empty]`, so the turn reads *user → [tool call] → [tool result] → assistant answer*. Also reconcile the streaming bubble with the re-render so the bubble doesn't visibly "fill then clear".
- **Notes**: Pre-existing (not introduced by the BUG-008 work — the per-message render was untouched). Only became visible now that BUG-008 no longer breaks the tool-call path before this point.


