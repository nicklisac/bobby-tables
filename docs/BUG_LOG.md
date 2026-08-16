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


