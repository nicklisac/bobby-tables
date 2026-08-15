# Ticket 11 Kickoff — 3-Pane Workstation Layout & Grid Engine (`dashboard_cards`)

## The project
**web-sql-agent** — a pure in-browser "SQL agent in a box." A single SQLite database (WASM, the `wa-sqlite` **JSPI** build, IndexedDB-backed VFS) is the agent's entire brain. The agent's ReAct cascade is driven by **SQLite triggers**, not JS: `agent_think` (AFTER INSERT on user rows) → `ask_llm` UDF → `execute_tool` trigger → `run_dynamic_sql`. No server backend; strictly local-first.

- Repo: `/home/nick/Documents/projects/web-sql-agent` (branch `main` → `origin/main` = `github.com/nicklisac/bobby`)
- Dev server: Vite on **`:5174`** (`npm run dev`). Live page handle: **`window.__agent`** → `{ sqlite3, db, ... }`.
- **Single source of truth:** `docs/WAYFINDER_MAP.md`. Read it first. Tickets **T1–T10 are COMPLETE**. You are starting **T11**.

## Your ticket
**Ticket 11 — 3-Pane Workstation Layout & Grid Engine** (`wayfinder:prototype`, HITL)

> How should the UI implement the 3-pane layout (DB Explorer / Chat & Console / 3×3 Reactive Canvas) and create the `dashboard_cards` SQLite table with `row_span` and `col_span` support?

**Locked from the map (do not re-litigate):** the right pane is a **dynamic 3×3 grid backed by `dashboard_cards` in SQLite**, supporting **merged cell spans**, **live SQL execution**, and (later, in T12) **drag-and-drop pinning from chat**.

### Scope (T11)
- Restructure the current single-column layout (`header` / `#config-panel` / `#chat-container` / `footer`) into **three panes**: **left = DB Explorer**, **center = Chat & Console** (the existing chat), **right = 3×3 Reactive Canvas**.
- Create the **`dashboard_cards`** table with `row_span` / `col_span` (plus whatever else the design needs: `id`, `title`, `sql`, position, `created_at`, …).
- Build the **grid engine**: place cards on the 3×3 grid, enforce **non-overlapping merged spans**, render each card's **live SQL result**, and provide card **CRUD** (add / remove / move / resize).

### Out of scope (do NOT build these — they are separate tickets)
- **T12:** HTML5 drag-and-drop from chat query results onto the grid. Build the grid so T12 can attach drop zones, but do **not** implement the drag-and-drop pinning itself.
- **T8:** the DB Explorer's full schema inspector (table list, column types, row counts, preview modals, "Save Query as View"). T11 provides the **left-pane shell**; a minimal table list as a placeholder is fine. T8 fills in the inspector.
- **T18:** full reactive-on-change dashboards via `v_dashboard_*` views. T11 = live execution + on-demand/manual refresh, not change-triggered reactivity.

### Open design questions — LOCK WITH THE USER before building (this is a HITL ticket)
1. **Session scoping:** is `dashboard_cards` **global to the brain** or **per-session** (`session_id` FK)? The grid is a workstation view — leaning global, but confirm.
2. **Card SQL semantics:** cards run **read-only `SELECT`s** (live views). Confirm cards never run DML/DDL — that keeps them outside T3's changeset capture and safe to re-run at any time.
3. **Grid geometry:** fixed 3×3 (9 cells) or 3×3 as a minimum? Confirm placement rules (free placement vs. auto-pack) and span constraints (max span, no overlap).
4. **Rendering:** what does a card render — a table, a single metric, a chart? (Charts/line-graphs are T18's territory; T11 probably = table + simple metric.)
5. **Reactivity:** "live" = poll interval, on-demand, or on data change? (T11 probably = on-demand + manual refresh button.)

## Hard constraints from prior tickets (do not break)
- **JSPI + IDB fiber-resumption race (the big one, root-caused 2026-08-14):** **never wrap `fetch` (or any LLM transport call) in an `async function` that adds a microtask tick before dispatching — return the native promise directly.** An async wrapper + a prior DB op in the same JS fiber before a turn causes the turn's first DB op (`sqlite3_prepare` suspending on an IDB schema read) to **never resume** — the browser auto-commits the open IndexedDB transaction, desyncing `IDBBatchAtomicVFS`'s `#chain` `#request`/`#txComplete` promises and deadlocking the resumed WASM fiber. Inspect responses via a separate `.then` + `resp.clone()` for SSE.
- **Don't pollute the LLM context:** `dashboard_cards` is **UI state, not `messages`**. It must **NOT** appear in `v_active_context` and must **NOT** be `in_context`. The agent's working context is the `v_active_context` view = [system row `id=0`] + [latest compaction summary] + [`in_context=1` messages past the watermark].
- **Cartridges (T10):** `VACUUM INTO` export automatically includes `dashboard_cards` — no work needed, but don't break it.
- **Savepoint protocol (T3):** each turn runs inside `SAVEPOINT turn_sp`; `SAVEPOINT` is illegal inside a trigger body; suppression flags (`suppress_cascade` / `suppress_capture`) must be reset in `try...finally`. Designing cards as read-only avoids all of this.
- **Schema migrations:** new tables use `CREATE TABLE IF NOT EXISTS` in `src/schema.js`. If a view changes, `DROP VIEW IF EXISTS` + recreate (existing brains pick it up at boot). The `agent_think` trigger is dropped + recreated at boot.
- **`window.__agent`** is the live handle for all probes.

## Verification bar (sign-off standard — the T2/T9 pattern)
1. **Probe** in `docs/prototypes/ticket-11-*.mjs`, run against the live page via `window.__agent`: assert the 3-pane layout renders, `dashboard_cards` is created, a card's SQL executes and renders, spans merge correctly with **no overlap**, card CRUD works, and (if scoping allows) a cartridge export includes the cards.
   - **The preview `evaluate` tool has a hard 15 s timeout:** long-running probes must store results on a `window` global and be polled with short evaluates.
2. **AGY review pass:** run `~/.config/opencode/scripts/agy-wrapper.sh check-usage` **first**; if quota is OK, spawn a review (default model `Gemini 3.7 Flash (Low)`). **Verify every claim empirically before accepting.** Fix blockers/majors; note minors.
3. **Commit + push:** message `feat: Ticket 11 — <description>`; push to `origin/main`.
4. **Close the ticket** on `docs/WAYFINDER_MAP.md`: status → ✅ COMPLETE, add a Resolution block, update the frontier graph (T11 → done; T12 unblocks).

## Workflow
1. Read `docs/WAYFINDER_MAP.md` (especially T11, T12, T8, T18, and the decision lines at the top).
2. Skim `src/schema.js`, `src/main.js`, `src/harness.js`, `index.html`, `src/styles.css` to understand the current layout and boot sequence.
3. Propose the design (schema + layout + grid-engine behavior + answers to the open questions) → **get the user's lock (HITL)** before building.
4. Build → verify with the probe → AGY review → commit → push → close the ticket.

## What NOT to do
- Don't re-litigate the locked 3-pane / grid / `dashboard_cards` decision.
- Don't implement T12's drag-and-drop pinning or T8's full schema inspector.
- Don't add `dashboard_cards` to the LLM context.
- Don't wrap `fetch` in an `async` function.
- Don't commit or push until the probe + AGY review are green.
