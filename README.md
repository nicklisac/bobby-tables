# Bobby Tables (Web SQL Agent)

Bobby Tables is a browser-based data analysis tool and SQL assistant. It runs on SQLite compiled to WebAssembly with JavaScript Promise Integration (JSPI), executing its core loop through SQLite triggers, views, and asynchronous user-defined functions (UDFs).

Instead of orchestrating the conversation entirely in JavaScript, the conversation history, tool calls, dashboard state, and execution loop live inside the SQLite database itself.

---

## How It Works

The host JavaScript handles browser I/O and network requests. The agent's control flow is driven by SQLite triggers:

```
[ User Input ]
       │
       ▼
 INSERT INTO messages (role, content)
       │
       ├─► Trigger: agent_turn_init
       │   Sets turn context and prepares changesets
       │
       └─► Trigger: agent_think
           Calls ask_llm(v_active_context, tools)
                 │
                 ▼
           [ LLM API Call ]
                 │
                 ▼
           INSERT INTO messages (role, 'assistant', tool_calls)
                 │
                 └─► Trigger: execute_tool
                     Calls UDF based on tool name:
                     - execute_sql
                     - search_web
                     - fetch_url
                     - materialize
                           │
                           ▼
                     INSERT INTO messages (role, 'tool', content)
                           │
                           └─► Re-triggers agent_think
```

1. **User Message Insert**: Inserting a user message into the `messages` table fires the `agent_turn_init` trigger to record the turn ID.
2. **LLM Invocation**: The `agent_think` trigger queries `v_active_context` (a view of active conversation messages and summaries) and passes it to the `ask_llm` UDF.
3. **JSPI Suspension**: SQLite WASM pauses execution during the network fetch and resumes when the LLM returns structured JSON.
4. **Tool Execution**: When the assistant returns tool calls, the `execute_tool` trigger runs the corresponding UDF and writes the result back into `messages` with `role = 'tool'`.
5. **Loop Continuation**: The tool insertion triggers `agent_think` again until the model returns a final text response with no tool calls.

---

## Interface Layout

The workspace has three resizable panes:

### 1. Database Explorer (Left)
- Inspects tables and views via `sqlite_master`.
- Shows column names, data types, primary keys, and row counts.
- Provides a 10-row preview modal for quick inspection.
- Displays table DDL definitions.

### 2. Chat and Direct SQL Console (Center)
- Displays the conversation stream, tool execution steps, and token usage metrics.
- Supports two direct SQL escape modes in the input field:
  - `!SELECT ...`: Executes SQL directly and inserts the result into `messages` so the agent sees it (`in_context = 1`).
  - `!!SELECT ...` / `!!DML`: Executes SQL privately without adding the output to the agent's context (`in_context = 0`).
- Schema-aware autocomplete for table names, column names, and SQL keywords.

### 3. Reactive Canvas Grid (Right)
- A 3x3 dashboard grid backed by the `dashboard_cards` table.
- Each card stores a SQL query, position (`row`, `col`), and dimensions (`row_span`, `col_span`).
- Drag table results from chat directly onto grid cells to create live cards.
- Cards re-run their queries when underlying tables update.

---

## Features

### Direct Tool-Output Materialization (`materialize`)
The `materialize` tool converts raw JSON from prior search or fetch tool outputs into permanent SQLite tables using `json_each()`. It infers column types (`INTEGER`, `REAL`, `TEXT`) and creates a structured table without re-transcribing data through the LLM.

### Rolling State Rewind and Savepoints
- Turns run within an atomic `SAVEPOINT turn_sp`.
- Triggers log row-level pre/post images in `turn_changesets` and schema modifications in `turn_ddl_log` (retaining up to 20 turns).
- Clicking the rewind button (`⟲`) on a message restores data and schema state to that specific turn while keeping conversation history intact.

### Interval Context Compaction
- Compaction runs when token usage approaches the model context window (or via `/compact`).
- Summaries are stored in the `compactions` table and advance an in-session watermark.
- The `v_active_context` view serves the system prompt, latest summary, and messages past the watermark. The full `messages` table remains untouched for auditing.

### CSV Import
- Drop `.csv` files directly onto the browser window.
- Infers types per column and creates corresponding tables.
- Automatically handles table name collisions with system tables.

### Cartridge Export and Import (`.sqlite3`)
- Export the current database state (data, sessions, messages, and dashboard cards) as a binary `.sqlite3` file using `sqlite3.serialize()`.
- Import existing cartridges to resume work or export `.sql` text dumps.

### Protected Tables
System tables (`system_config`, `tools`, `messages`, `sessions`, `turn_changesets`, `compactions`, `dashboard_cards`) are protected from destructive DDL statements to prevent accidental corruption while allowing standard queries.

---

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- A browser with WebAssembly JSPI support (Chrome 119+ or Edge with experimental JSPI enabled)

### Installation and Run

```bash
# Clone the repository
git clone https://github.com/your-org/web-sql-agent.git
cd web-sql-agent

# Install dependencies
npm install

# Start development server
npm run dev
```

Visit `http://localhost:5174` in your browser.

---

## LLM Configuration

Open the **Settings** modal in the top-right corner to configure provider settings:

- **Google Gemini**: Set your Gemini API key (default model: `gemini-2.5-flash`).
- **OpenAI**: Set your OpenAI API key and model name.
- **Local Endpoints (Ollama / LM Studio)**: Point the base URL to your local server (for example, `http://localhost:11434/v1` for Ollama).
- **OpenRouter**: Set your OpenRouter API key and model string.

---

## Commands and Shortcuts

| Command | Action |
| :--- | :--- |
| `!SQL` | Execute SQL directly and share output with the agent. |
| `!!SQL` | Execute private SQL directly without adding to agent context. |
| `/compact` | Trigger manual context compaction. |
| `/compact [notes]` | Trigger context compaction with custom summary guidance. |
| **Double-click divider** | Reset pane widths to defaults (250px left, 440px right). |
| `⟲` icon | Rewind database state to that turn. |
| **Stop button** | Abort current generation or tool execution. |

---

## Project Structure

```
web-sql-agent/
├── src/
│   ├── schema.js             # SQLite schema, tables, triggers, and session queries
│   ├── harness.js            # SQLite WASM bootloader, JSPI UDFs, and LLM calls
│   ├── compaction.js         # Context compaction and summary generation
│   ├── rewind.js             # Changeset rewind and savepoint management
│   ├── materialize.js        # JSON tool output to SQLite table conversion
│   ├── csv-ingestion.js      # CSV parser and table generation
│   ├── cartridge.js          # .sqlite3 binary import/export and .sql dump
│   ├── explorer.js           # Database catalog introspection
│   ├── explorer-ui.js        # Schema explorer UI and preview modals
│   ├── grid.js               # Dashboard grid logic and cell spanning
│   ├── grid-ui.js            # Grid rendering and drag-drop handlers
│   ├── sql-autocomplete.js   # SQL autocomplete and editor popover
│   ├── panes.js              # Resizable pane dividers
│   ├── main.js               # Application startup and event handling
│   └── styles.css            # Styles
├── vendor/
│   └── wa-sqlite-jspi/       # JSPI-enabled SQLite WASM build
├── index.html                # Main page
├── package.json
└── vite.config.js            # Vite configuration with required headers
```

---

## License

MIT
