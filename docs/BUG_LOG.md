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
- **Status**: Open / Backlogged
- **Reported**: User Feedback
- **Component**: `src/main.js`, `index.html`, `src/styles.css`
- **Description**: When an LLM provider is not set or configured, the user can still type and attempt to send chat messages, leading to failed requests or unhandled errors. Users should be directed to the provider settings/list before they try to chat.
- **Root Cause**: Chat input and submit controls are enabled on initialization without validating whether an active LLM provider, API key, or valid endpoint has been configured in local storage / settings.
- **Proposed Fix**: Guard the chat input on initial load: detect if a provider is unconfigured, display an onboarding banner/prompt guiding the user to open the LLM Configuration modal (`#config-modal`), and keep normal LLM chat submission disabled until a provider is configured (or direct them automatically to the provider setup).

---

### BUG-005: Limited LLM Provider Selection (Missing Major Industry Providers)
- **Status**: Open / Backlogged
- **Reported**: User Feedback
- **Component**: `src/harness.js`, `src/main.js`, `index.html`
- **Description**: The application currently only provides options for generic OpenAI-compatible endpoints and Google Gemini. Support is needed for the major LLM providers out of the box (e.g., Anthropic Claude, OpenAI official, Google Gemini, Groq, Mistral, OpenRouter, and local Ollama/LM Studio presets).
- **Root Cause**: The configuration UI (`#config-provider`) and HTTP transport in `src/harness.js` only implement request/response framing for generic OpenAI-compatible completions and Gemini REST APIs.
- **Proposed Fix**: Expand the provider list and transport layer to support major LLM providers natively, including Anthropic Claude (Messages API format), OpenAI direct, Groq, Mistral, OpenRouter, and local providers with preset endpoints and default model selections.

