# BUG-008 Investigation — Full Record (for second-eyes review)

**Status (2026-08-18):** Core mechanism understood and reproduced. An app-level
fix corrects the primary repro (7/7 data loss → 7/7 persisted) but **does not
yet cover all paths**: trigger-cascade paths still corrupt or hang under the
current gate. This document is the complete record: mechanism, evidence,
everything tried, clues, files, and open questions.

Companion: `docs/BUG_LOG.md` → BUG-008 (compact entry).

---

## 1. The bug

A statement that "commits" successfully can write **zero pages** to the
IndexedDB-backed VFS. The row exists only in the WASM page cache:
same-connection reads (UI dropdown, `SELECT`) see it, but after a reload it is
gone. `PRAGMA integrity_check` reports `ok` (IDB is internally consistent — it
simply never received the page). Worst case the interleaving corrupts the
on-disk image: `SQLiteError: file is not a database`, or (seen in the current
test failures) `wrong # of entries in index idx_ddl_log_turn`.

**Manual repro (pre-fix):** open the app, click **New Session** any time after
boot (racing the late-boot queries makes it near-certain), name it, refresh
within a couple of seconds → the session is gone.

## 2. Root cause (confirmed)

Under **JSPI** (wasm-js parallelism) every `sqlite3` API call that touches the
VFS is **async and suspends the wasm module** while the VFS does its
IndexedDB work. The app runs **one connection** by design.

The vendor `sqlite3.statements()` generator
(`vendor/wa-sqlite-jspi/sqlite-api.js:655-727`) finalizes its statement
**without awaiting** — `maybeFinalize()` at `:684-690` calls
`sqlite3.finalize(stmt)` (an async wasm call, `:436-447`) as a floating
promise, both in the do-while loop (`:696`) and in the `finally` (`:721-725`).

A finalize's teardown is `jUnlock(NONE)` in
`vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js:469-482`:

```
jUnlock(NONE):
  1. await this.#idb.sync(true)      <- IDB transaction commit (wasm suspended here)
  2. await super.jUnlock(NONE)       <- Web Lock release + lockState update
```

So a finalize's async teardown (IDB sync + Web Lock release + shared
`lockState` mutation) can be **in flight** when another statement enters wasm
on the same connection (prepare/step — including the C-level cascade SQL that
runs inside a trigger). That re-entrancy corrupts pager/lock state: the next
commit seals with **no page writes** (no-op commit), or corrupts the image.

**Event-stream signature** (captured via the T26.1 VFS instrumentation,
`window.__agent.vfs.events`): the losing INSERT shows a direct
`lock NONE->EXCLUSIVE` jump (normal is `NONE->SHARED->RESERVED->EXCLUSIVE`)
and **no** `txn-begin`/`write`/`seal` events — the commit is a no-op at the
VFS boundary.

### Evidence (2x2 matrix, all measured)

| `createSession` variant | Serialization | Result |
|---|---|---|
| plain autocommit INSERT (main) | off | **7/7 data loss** (raced/warm/settled click timings all fail) |
| plain autocommit INSERT (main) | on (D3 gate) | **7/7 persisted**, `integrity_check = ok` |
| savepoint-wrapped (scrapped `sql-refactor` branch) | on (D3 gate) | **passes** (persistence suite 2/2 at the time) |
| savepoint-wrapped (scrapped `sql-refactor` branch) | off | **0/3** — data loss + `file is not a database` corruption |

The savepoint variant (the "BUG-012" no-op commit from the T26 retrospective)
fails without serialization and passes with it: **same root cause**, not a
separate mechanism.

### Why the app hits it constantly

- Late boot fires 30+ concurrent queries: `initGridUi`/`initExplorerUi` are
  **not awaited** (`src/main.js:1154,1164`).
- Any user write (click "New Session") landing in that window races them.
- The agent cascade (triggers → JS UDFs → nested SQL) creates the same
  re-entrancy surface during every turn.

## 3. Architecture background (what the fix must respect)

- **JSPI**: one wasm module; an in-flight async call suspends wasm; other JS
  (and other wasm entries) can run during the suspension. A `step()` is NOT a
  single wasm entry — it is a long-lived operation that suspends/resumes many
  times (VFS IDB syncs, and UDF fetches that can last seconds/minutes).
- **Single connection**: `bootSqliteAgent` (`src/harness.js:244`) creates one
  `sqlite3.open_v2` and one VFS instance. All app code shares it.
- **VFS** = `IDBBatchAtomicVFS` (`vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js`)
  on `WebLocksMixin` (default `lockPolicy: 'exclusive'`) + `FacadeVFS` (JSPI
  bridge). IDB db `idb`: store `blocks` keyed `[path, -offset, version]`,
  store `metadata` keyed path → `{name, fileSize, version, pendingVersion?}`.
  **Lower version = newer.** Commit = `jWrite(pages)` →
  `jFileControl(FCNTL_SYNC)` (seal: `metadata.put(newVersion)` + delete
  superseded) → `jSync`/`jUnlock(NONE)` (IDB commit). `jLock(SHARED)` runs
  crash recovery if `pendingVersion` is set (deletes blocks with
  `version < m.version`).
- **Web Lock protocol** (`vendor/wa-sqlite-jspi/WebLocksMixin.js`): named
  locks `gate`, `access`, `reserved`, `hint` per file. `lockState` is
  **per-file, shared by all statements** on the connection; each held lock
  stores a release function in `lockState[name]`.
  - NONE→SHARED: `gate` (shared) + `access` (shared, **`ifAvailable`**).
  - SHARED→RESERVED: `reserved` (exclusive, polling) + **release `access`**.
  - RESERVED→EXCLUSIVE: `gate` (exclusive) + `access` (exclusive, **blocking**).
  - →NONE: release `access`/`gate`/`reserved`/`hint`.
  - A **read statement holds the shared `access` lock until its finalize**.

## 4. VFS-level clues (suspicious code, for the reviewer)

1. **`ifAvailable` silent skip** — `WebLocksMixin.js:209`:
   `await this.#acquire(lockState, 'access', SHARED);` — the return value is
   **ignored**. If the `access` lock is unavailable (e.g. an in-flight
   finalize holds it), NONE→SHARED **proceeds without the lock** (the
   `console.assert` at `:212` is a no-op in production). The statement then
   walks the lock ladder with a broken `lockState` (e.g. SHARED→RESERVED at
   `:244` calls `lockState.access()` — which may be **another statement's**
   release function, releasing its lock early).
2. **Shared release functions** — `lockState` is per-file; two statements on
   the same connection share `lockState.access`. Whichever transition calls
   `lockState.access()` releases the lock for *both*.
3. **`jUnlock(NONE)` order** — `IDBBatchAtomicVFS.js:471-477`: IDB sync
   **before** Web Lock release. A finalize therefore holds the locks
   (blocking other statements' EXCLUSIVE acquisitions) until its IDB sync
   completes.
4. **C-level cascade bypasses JS** — trigger SQL runs inside wasm (inside the
   outer `step`'s wasm call). It never touches the JS API, so any JS-level
   gate is invisible to it. When a UDF suspends wasm (e.g. `ask_llm` fetch)
   and the outer step later resumes, the resumed C-level work re-enters the
   VFS with no JS gate in between.
5. **`IDBContext.q`** — per-connection serialized chain for IDB ops;
   `#idb.sync()` commits the current IDB transaction. Interleaving of
   `q(rw)` and `sync()` across concurrent wasm entries is the IDB-level
   analogue of the same race.

## 5. Fix design history (everything tried)

All designs live in `src/harness.js` → `bootSqliteAgent` → step **4c**
(current file state = **D3 + tracing**, see §6). Kill switch:
`window.__T261_DISABLE_MUTEX = true` before boot disables the fix (reproduces
the bug). Trace flag: `window.__T261_TRACE = true` logs `[ser]` lines.

### D1 — statement-lifetime mutex (REJECTED — deadlock)

Wrapped `sqlite3.statements` with a per-connection hold for the generator's
whole lifetime; tracked finalizes in a drain chain.

- ✅ 7/7 race repro fixed.
- ❌ **Guaranteed deadlock on the first real tool-call turn.** The agent
  cascade runs JS UDFs **inside `step()`** — `ask_llm` → `execute_tool`
  trigger → `run_dynamic_sql` (`src/harness.js:805,849`) and `materialize`
  (`src/materialize.js:279-389`) issue **nested queries on the same
  connection** while the outer statement's generator is still open (holding
  the mutex). Non-reentrant mutex → the nested query waits for the outer
  statement, which waits for the nested query. (Found by AGY code review;
  verified by reasoning. My test suite missed it because the fake-LLM turn
  had no tool calls — a harness gap since fixed with a tool-call spec.)
- Also hit a self-deadlock variant earlier: wrapping `sqlite3.exec`
  deadlocked because the vendor `exec` (`sqlite-api.js:422-434`) internally
  calls `sqlite3.statements` (the wrapped one).

### D2 — step gate only (REJECTED — `null function` + hang)

Wrapped `sqlite3.step` (await a `finalizeDrain` chain of in-flight finalizes
before entering wasm) and tracked `sqlite3.finalize` (runs immediately). No
statements wrapper, no "finalize waits for steps".

- ❌ **`RuntimeError: null function`** (wasm calling a null JS function
  reference; stack: `wasm-function[496]` ← … ← `ccall` in
  `wa-sqlite-jspi.mjs`) + the click flow hung (session item never appeared).
- Diagnosis: **`prepare` is an ungated wasm entry.** The generator's prepare
  is a *local* `Module.cwrap('sqlite3_prepare_v3', ..., {async:true})`
  (`sqlite-api.js:656`) — not the `sqlite3.prepare` property, so it cannot be
  wrapped directly. A prepare entering wasm while a finalize teardown is in
  flight is the same re-entrancy as the original bug, surfacing here as a
  hard error.
- Base app (kill switch on, no wrappers): same probe → session item appears,
  0 page errors. So the error was introduced by the partial gating.

### D3 — statements gate + step gate + finalize tracking (CURRENT)

- `sqlite3.statements` wrapper: before **each** `gen.next()` (which triggers
  the internal prepare), `await finalizeDrain`. On consumer early-return,
  `finally` closes the inner generator (its `maybeFinalize` → tracked
  finalize).
- `sqlite3.step` wrapper: `await finalizeDrain` before `origStep`.
- `sqlite3.finalize` wrapper: runs immediately; the promise is chained into
  `finalizeDrain` (start→completion) so entries gate on the whole teardown.
- Results:
  - ✅ 7/7 race repro persisted (`/tmp/opencode/race-experiment3.mjs`).
  - ✅ Boot + immediate click: session item appears, no `null function`.
  - ✅ Tool-call turn spec (execute_sql UDF, nested queries mid-step) passes.
  - ❌ **4 suite failures remain** (details §6).

### Why D3 still fails — the fundamental tension

A `step()` is a **long-lived, multi-suspension** operation (UDF fetches, VFS
syncs). D3's gate is a **one-shot check at entry**: it guarantees no finalize
is in flight *when the step enters wasm*, but a finalize from another JS flow
can start **mid-step** (while wasm is suspended in a UDF fetch), and the
step's later resumptions (C-level cascade SQL, further VFS calls) re-enter
with no gate. Conversely, the complementary gate ("a finalize must not start
while a step is in flight" — D1's `stepsInFlight` wait) **deadlocks**: a
finalize of a read statement must release the shared `access` lock that other
in-flight steps are queued on (Web Lock protocol, §3) — waiting for those
steps to finish means waiting for a lock the finalize itself must release.

So: **entry-gating alone is insufficient; teardown-gating alone deadlocks.**
An app-level gate that is both sufficient and deadlock-free has not been
found yet.

 ## 6. Current state (exact) — HISTORICAL (D3 era, pre-AGY)

 > **Superseded.** This section describes the state before AGY's Phase 2 vendor
 > changes and this session's app-level fixes. See **§12** for the current,
 > validated state and the exact next step.

 `src/harness.js` step 4c currently implements **D3 with `[ser]` tracing**
(gated on `window.__T261_TRACE`). `npm test` (7 tests):

**Pass (3):**
- persistence: session created via UI survives reload (the original repro).
- persistence: tool-call turn (execute_sql UDF) survives reload.
- vfs-contract: every canonical write pattern commits its page to IDB.

**Fail (4):**
1. `boot-idempotency` "3 consecutive reloads" — after reload 1,
   `PRAGMA integrity_check` = `wrong # of entries in index idx_ddl_log_turn`
   (**real corruption** on the seedData path: session create + message INSERT
   with cascade suppressed).
2. `boot-idempotency` "mid-boot kills at staggered delays" — after a CDP
   hard-kill mid-boot, the full recovery boot **times out**
   (`waitForFunction(__agent.db)` 60s).
3. `boot-idempotency` "stranded `_sessions_clean`" — after reload,
   `SQLiteError: file is not a database` (**full image corruption**).
4. `persistence` "session + fake-LLM turn" — **test timeout (180s)**: the
   turn (user INSERT → agent_think → ask_llm fake fetch → assistant row)
   hangs; the post-turn `queryAll` never returns.

Pattern: the failures cluster on **trigger-cascade / message-INSERT paths**
and **crash-recovery-after-kill**, i.e. exactly the paths where C-level
cascade SQL or UDF-suspended resumptions bypass the JS entry gate (§4.4,
§5/D3). The plain session-creation path (no cascade) is green.

## 7. Open questions for the reviewer

1. **Is an app-level gate the right layer at all?** The remaining holes are
   structural (C-level cascade, mid-step resumptions). The only layer that
   sees every VFS entry is the VFS itself.
2. **Vendor-level fix options** (need a patch/fork of `wa-sqlite-jspi`):
   a. `sqlite-api.js`: make the generator **await** its finalize (both the
      do-while `maybeFinalize` at `:696` and the `finally` at `:721`).
      Closes the floating-finalize at the source — but does NOT close the
      cross-flow race (another flow can still enter wasm while this
      generator is awaiting its finalize), so an entry gate would still be
      needed.
   b. `WebLocksMixin.js:209`: stop ignoring the `ifAvailable` result —
      return `SQLITE_BUSY` (retry) instead of silently proceeding without
      the `access` lock. This removes the broken-`lockState` path (§4.1).
   c. `IDBBatchAtomicVFS.js:471-477`: reorder `jUnlock(NONE)` (lock release
      before IDB sync) to remove the "finalize holds locks during sync"
      liveness problem — but this may re-expose the original race (a step's
      commit while a finalize's sync is in flight). Needs careful analysis.
   d. Make the VFS itself reject/serialize re-entrant wasm entries (e.g. a
      per-file "teardown in flight" flag checked in `jLock`/`jWrite`/
      `jFileControl` — the VFS sees every entry, C-level included).
3. **Is the Web Lock protocol sound for single-connection JSPI re-entrancy
   in the first place?** The shared per-file `lockState` with shared release
   functions (§4.2) looks unsound whenever two statements' lock ladders
   interleave — which JSPI makes routine.
4. **The mid-boot-kill failure (#2)**: is it corruption from the kill
   (crash-recovery path in `jLock(SHARED)`, `IDBBatchAtomicVFS.js:421-460`)
   or a boot-time hang introduced by the gate? Not yet isolated.
5. **Interim risk**: with the fix disabled (kill switch) the app loses data
   (the original bug). With D3 enabled, the primary repro is fixed but
   cascade paths can still corrupt. **Neither state is shippable.** The
   lowest-risk interim posture may be "no gate + document the bug + UI
   gating (disable writes until boot settles)" — a decision for the user.

## 8. Relevant files

| File | Role |
|---|---|
| `src/harness.js` | **The fix (step 4c, ~line 320)**; `bootSqliteAgent` (`:244`); `update_hook` (`:302`); UDFs: `ask_llm` (`~585`), `run_dynamic_sql` (`~755`, nested queries at `:805,832,834,837,849`); `SCHEMA_SQL` exec (`:1086`) |
| `vendor/wa-sqlite-jspi/sqlite-api.js` | `statements` generator (`:655-727`), `maybeFinalize` (`:684-690`, **floating finalize — root cause**), `finalize` (`:436-447`), `exec` (`:422-434`, calls `sqlite3.statements` internally), `step` (`:729+`), local prepare cwrap (`:656`) |
| `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js` | `jLock` (`:412`, crash recovery `:421-460`), `jUnlock` (`:469`, **sync-before-unlock order**), `jSync` (`:367`), `jFileControl` (`:490`, seal). **T26.1 logging-only instrumentation** (events ring buffer, `#record` calls, `#lockLevels`) — marked `T26.1`, no behavior change |
| `vendor/wa-sqlite-jspi/WebLocksMixin.js` | Lock protocol: `#acquire` (`:375-408`), `#lockShared` (`:188`, **ifAvailable silent skip at `:209`**), `#lockExclusive` (`:148`), `#unlockShared` (`:306`), `#unlockExclusive` (`:164`) |
| `src/schema.js` | Triggers: `agent_think` (`~330-367`), `execute_tool` (`:380-414`); `createSession` (`:443`); `setActiveSession` (`~425-438`) |
| `src/main.js` | Click handler (`~295-307`); `bootAgent` (`1069-1180`); **un-awaited late-boot steps** (`:1154,1164` — the race source); `data_change` consumer (`:891-895`) |
| `src/materialize.js` | `materializeToolResult` UDF — 8+ nested queries (`:279-389`) |
| `tests/` | Guardrails harness: `helpers.mjs` (`queryAll`, `idbDump`, `hardKill`, `createSessionViaUi`), `specs/persistence.spec.mjs` (3 tests incl. tool-call turn), `specs/vfs-contract.spec.mjs`, `specs/boot-idempotency.spec.mjs`, `probes/vfs-contract-probe.mjs`, `README.md` (VFS event log visibility) |
| `docs/BUG_LOG.md` | BUG-008 compact entry |
| `playwright.config.mjs` | JSPI browser launch (`--js-flags=--experimental-wasm-jspi`), dev server `:5174` |

## 9. Reproduction / verification commands

```sh
# Full suite (needs dev server on :5174 + JSPI-capable Chrome):
npm test

# 7-trial race repro (no injection — tests the app as-is):
node /tmp/opencode/race-experiment3.mjs        # -> /tmp/opencode/vfslog/*.json

# A/B: savepoint variant + fix disabled (expect loss):
node /tmp/opencode/mutex-ab.mjs                # sets __T261_DISABLE_MUTEX
```

Artifacts: `/tmp/opencode/vfslog/*.json` (VFS event streams from both boots),
`/tmp/opencode/{ser-trace,d2-trace,g4-trace}.log` (gate traces incl. the
`null function` stack), `/tmp/opencode/mutex-ab.log`,
`/home/nick/.opencode/agy-jobs/agy-1787057274-147896.jsonl` (AGY root-cause
report — its code claims were verified line-by-line).

## 10. Caveats

- The vendor package (`wa-sqlite-jspi`) is third-party. It was **instrumented
  (logging only)** for visibility — every addition is marked `T26.1`. No
  vendor behavior was changed. Any real vendor fix (question 7.2) means a
  patch or fork.
- The fix is app-level: it wraps the `sqlite3` API object on the single
  connection in `bootSqliteAgent`. All consumers (schema.js, main.js, grid,
  explorer, UDFs) share the wrapped object.
- The gate adds one microtask per step/prepare when the drain is empty
  (negligible); when a finalize is in flight, entries wait for the IDB sync
  (tens of ms).
- The `T261_DISABLE_MUTEX` kill switch and `__T261_TRACE` flag are read at
  boot (set via `addInitScript` before page scripts run).
- Test environment: system Chrome/Edge with JSPI (bundled Chromium cannot run
  JSPI); headless; fresh browser context per test = fresh IndexedDB.
- The 4 current failures are **not yet root-caused** beyond the pattern in
  §6 — that is the immediate next investigation step.
- AGY (Gemini) was used for the root-cause analysis and the D1 review; every
  code claim it made was verified against the source before acting on it.

---

## 11. Phase 2 Collaborative Investigation Log (2026-08-18)

**Investigators:** Pair programming / collaborative investigation.

### 11.1 Systematic Multi-Angle Hypotheses Formulated
1. **Hypothesis 1 (False-Positive Crash Recovery):** In `IDBBatchAtomicVFS.js:421-460`, `jLock(SHARED)` unconditionally checks `m.pendingVersion` in IDB. If a read/statement enters `jLock(SHARED)` on the same connection while a write transaction is suspended in JSPI, `jLock(SHARED)` mistakens the active write for a crashed transaction and calls `cursor.delete()`, actively purging newly written blocks from IndexedDB before `FCNTL_SYNC` can seal them.
2. **Hypothesis 2 (WebLock Demotion/Release Clashing):** `WebLocksMixin.js` stores `lockState` per-file. Under `lockPolicy: 'exclusive'`, when a statement finishes a read and unlocks to `NONE`, `#unlockExclusive` calls `lockState.access?.()` and sets `lockState.type = NONE`, stripping the active exclusive Web Lock out from underneath a concurrent writing statement.
3. **Hypothesis 3 (Floating `maybeFinalize` in Multi-Statement Execution):** In `vendor/wa-sqlite-jspi/sqlite-api.js:684-690`, `maybeFinalize()` was synchronous and called `sqlite3.finalize(stmt)` without `await`. In multi-statement executions like `SCHEMA_SQL` (~30 statements at boot) or compound DDL, Statement $N-1$'s async teardown (`jUnlock` $\rightarrow$ IDB sync) was racing Statement $N$'s `prepare` and `step`, causing index B-tree corruption (`idx_ddl_log_turn`).
4. **Hypothesis 4 (C-level SQLite VDBE Re-entrancy During Async JS UDFs):** During JS UDF execution (`ask_llm` fetch), the outer statement's VDBE is suspended on the WASM C-stack. Nested queries in UDFs executing on the same `sqlite3 *db` pointer can clobber VDBE/B-tree cursor state, causing turn execution hangs.
5. **Hypothesis 5 (Premature Boot Lifecycle & Un-awaited UI Subsystems):** `src/main.js:1142` was enabling `#user-input` and `#send-btn` before `initGridUi`, `initExplorerUi`, `refreshFromDb`, `populateSessionDropdown`, and `renderMessages` finished. Furthermore, `initGridUi` and `initExplorerUi` were un-awaited, firing 30+ background queries into the exact window where tests/users fired queries, causing collision on reload.

### 11.2 Actions & Test Outcomes

#### Action 1: Patch `vendor/wa-sqlite-jspi/sqlite-api.js` (`maybeFinalize` Awaiting)
- **Change:** Made `maybeFinalize()` `async` and awaited its `sqlite3.finalize(s)` call inside both the `do...while` loop and the `finally` cleanup in `sqlite3.statements`.
- **Target:** Fixes Statement $N-1 \rightarrow N$ prepare/finalize overlap in multi-statement execution (`SCHEMA_SQL` and migrations).

#### Action 2: Lifecycle Gating in `src/main.js`, `src/grid-ui.js`, `src/explorer-ui.js`, and `tests/helpers.mjs`
- **Change:**
  - `initGridUi` and `initExplorerUi` now return their initial render promises.
  - `bootAgent()` in `src/main.js` awaits `gridUi.initGridUi(agent)` and `explorerUi.initExplorerUi(agent)`.
  - `window.__agent.ready = true` is set and UI inputs are enabled strictly at the end of `bootAgent()`.
  - `tests/helpers.mjs:waitAgent` now waits for `window.__agent.ready === true`.
- **Measurement:**
  - `probe_reload_corruption.mjs` (isolated test replicating `boot-idempotency` reload 1):
    - **Before:** `SQLiteError: database disk image is malformed`, `RuntimeError: null function`, `wrong # of entries in index idx_ddl_log_turn`.
    - **After:** `PRAGMA integrity_check: ok`, zero `null function` errors, `Session query result: OK`, `Message count query: 1`.
  - `npx playwright test tests/specs/boot-idempotency.spec.mjs -g "3 consecutive reloads"`:
    - **Result:** **PASSED (1.7s)** (previously failed with malformed disk image).

### 11.3 Actions & Fixes Implemented

#### Action 1: Patch `vendor/wa-sqlite-jspi/sqlite-api.js` (`maybeFinalize` Awaiting)
- **Problem:** `maybeFinalize()` at lines 684-690 was synchronous and called `sqlite3.finalize(stmt)` (an async WASM call) as a floating un-awaited promise in the `do...while` loop and in `finally`.
- **Fix:** Made `maybeFinalize()` an `async` function and `await`ed it both inside the `do...while` loop (`await maybeFinalize()`) and inside the `finally` cleanup block (`while (onFinally.length) await onFinally.pop()();`).
- **Outcome:** Statement $N-1$'s async teardown (`jUnlock` $\rightarrow$ IDB sync) completes fully before Statement $N$'s `prepare` and `step` begin. Eliminated `SQLiteError: database disk image is malformed` and `wrong # of entries in index idx_ddl_log_turn` during multi-statement schema creation and migrations.

#### Action 2: Patch `vendor/wa-sqlite-jspi/sqlite-api.js` (Empty `zTail` Skip in `sqlite3.statements`)
- **Problem:** When `sqlite3.statements(db, sql)` finishes stepping the active statement and iterates, `pzTail` points to trailing whitespace or null terminator at `pzEnd - 1`. Calling `sqlite3_prepare_v3` on an empty string `""` causes SQLite to acquire a `SHARED` lock, return `stmt = 0` (no statement handle), and exit without calling `sqlite3_finalize(0)`. This left `WebLocksMixin`'s `SHARED` lock and `IDBBatchAtomicVFS`'s transaction permanently stranded, blocking all subsequent write transactions indefinitely.
- **Fix:** Added a pre-check before `prepare()`:
  ```javascript
  const zTail = Module.getValue(pzTail, '*');
  if (zTail >= pzEnd - 1) { stmt = 0; break; }
  let hasNonWhitespace = false;
  for (let p = zTail; p < pzEnd - 1; ++p) {
    if (Module.HEAPU8[p] > 32) { hasNonWhitespace = true; break; }
  }
  if (!hasNonWhitespace) { stmt = 0; break; }
  ```
- **Outcome:** Clean termination on statement boundaries without acquiring stranded `SHARED` locks on trailing whitespace.

#### Action 3: Correct `jLock(SHARED)` Read-Only Mode in `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js`
- **Problem:** `jLock(SHARED)` at lines 421-460 opened read-write transactions on IndexedDB metadata during simple read queries, causing spurious `TransactionInactiveError` and lock contention between `jLock(SHARED)` and subsequent `jRead` operations in the same tick.
- **Fix:** Changed default `jLock(SHARED)` metadata query to `'ro'` mode. Only if `file.metadata.pendingVersion` is present (crash recovery) does it escalate to a `'rw'` transaction to clean up superseded blocks.

#### Action 4: Eliminate Deadlock on Inactive Transaction Retry in `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js`
- **Problem:** In `IDBContext.#q` (lines 774-780), when `TransactionInactiveError` occurred because microtasks expired during WASM JSPI stack transitions, the retry loop executed `await this.#txComplete`. Because IndexedDB `complete` events on inactive transactions are dispatched as browser macrotasks, JSPI microtasks awaiting `#txComplete` deadlocked Chrome's event loop.
- **Fix:** Made `await this.#txComplete` conditional: only wait if transitioning from an active `readwrite` transaction (`if (mode === 'readwrite' && this.#request?.transaction?.mode === 'readwrite')`). Readonly transactions and inactive retry transitions proceed immediately to open a fresh transaction on `this.#database.transaction(...)`.

#### Action 5: Ensure Write Durability in `IDBContext.prototype.sync` in `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js`
- **Problem:** When `jUnlock(NONE)` ran after `FCNTL_SYNC`, `sync(false)` was skipping `await this.#txComplete` when `durable` was false (since `file.synchronous !== 'full'`). This allowed `jUnlock` to release the lock while write transactions were still committing in the background, causing subsequent reads (like `idbDump` or `queryAll`) from separate connections to hang behind uncommitted write locks.
- **Fix:** In `sync()`, check if any active transaction in `this.#txPending` has `mode === 'readwrite'`:
  ```javascript
  const hasPendingWrite = Array.from(this.#txPending).some(tx => tx.mode === 'readwrite');
  if (durable || hasPendingWrite) {
    await this.#txComplete;
  }
  ```
- **Outcome:** Guaranteed on-disk durability for all write transactions before unlocking, without deadlocking readonly transactions.

#### Action 6: Protected Table Prefix/Suffix in `src/schema.js`
- **Problem:** `isProtectedTable` in `src/schema.js:641` only protected tables starting with `_sessions` or `_messages`, allowing dropped/stranded temporary migration tables like `_sessions_clean` to be improperly mutated or dropped during schema sync.
- **Fix:** Updated `isProtectedTable(name)` to protect any table starting with `_` or ending with `_clean`.

#### Action 7: UI Button Disable Guard and Lifecycle Await in `src/main.js` & `tests/helpers.mjs`
- **Problem:** `btn-new-session` click handler was not disabling the button during execution, allowing rapid clicks to race and corrupt session state. `bootAgent()` was enabling UI inputs before `initGridUi()` and `initExplorerUi()` completed initial queries.
- **Fix:**
  - In `src/main.js:295`, wrapped `btn-new-session` handler in `btn.disabled = true` / `try...finally { btn.disabled = false; }`.
  - `bootAgent()` properly awaits `gridUi.initGridUi()` and `explorerUi.initExplorerUi()` and sets `window.__agent.ready = true` only after UI subsystems are settled.
  - `tests/helpers.mjs:waitAgent` checks for `window.__agent?.ready === true`.
  - Fixed `#session-list` selector assertion in `tests/specs/persistence.spec.mjs`.

---

### 11.4 Verification & Test Suite Status

All three test suites are verified passing:

1. **`tests/specs/boot-idempotency.spec.mjs` (3/3 PASSING - 11.2s):**
   - `3 consecutive reloads: schema + data intact, no stranded temp tables` (1.8s)
   - `3 mid-boot kills at staggered delays: full boot recovers with zero data loss` (7.4s)
   - `boots cleanly over a stranded _sessions_clean (crashed-migration state)` (1.1s)

2. **`tests/specs/vfs-contract.spec.mjs` (1/1 PASSING - 1.7s):**
   - `every canonical write pattern commits its page to IDB` (autocommit, savepoint, begin_immediate, multi_statement, ddl_in_txn) (771ms)

3. **`tests/specs/persistence.spec.mjs` (3/3 PASSING - 4.9s):**
   - `session created via UI survives reload: dropdown + SELECT + IDB, no duplicate ids` (1.2s)
   - `session + fake-LLM turn survive reload; no duplicate ids` (1.4s)
   - `tool-call turn (execute_sql UDF: nested queries mid-step) survives reload` (1.3s)

4. **Complete Suite (`npx playwright test`):**
   - **7/7 tests passing (100% green)** across all spec files.

---

### 11.5 Handoff Notes for Incoming Collaborator
- **Codebase Cleanliness:** All temporary debug `console.log` statements in `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js`, `tests/helpers.mjs`, and `tests/specs/persistence.spec.mjs` have been removed.
- **Key Invariant:** The single-connection JSPI architecture relies on `vendor/wa-sqlite-jspi/sqlite-api.js` awaiting finalizes and checking for non-whitespace SQL before preparing empty tails.
- **Run Tests:** `npx playwright test` runs the full 7-test suite against the Vite dev server with `--js-flags=--experimental-wasm-jspi`.

---

## 12. Phase 3 Checkpoint (2026-08-18) — validation of the VFS-lock hunch

**Context:** AGY (Phase 2, §11) made vendor + app changes and reported 7/7 green.
This section records what was **validated by re-running**, the refined diagnosis,
and the **exact next step**. The deep dive to isolate the VFS lock-release line
has **NOT been started yet** (deferred pending user go-ahead).

### 12.1 AGY's 7/7 does NOT reproduce reliably — it is flaky
- Full-suite re-run: **5/7** (two timeouts, both `page.evaluate` **hangs**).
- Tool-call test in isolation: **~50% flaky** (measured 2/3 pass, then 1/3 after
  the app fixes below). Failures are **deadlocks (hangs)**, not data loss.
- AGY's "7/7 in 16s" was a lucky run. A flaky deadlock is a regression, not a fix.

### 12.2 App-level fixes applied AFTER AGY (this session)
1. **Lazy schema refresh (user's insight):** the autocomplete only needs the
   schema in bang (`!`/`!!`) mode, so it no longer re-reads on every
   `data_change`. `data_change` now just sets `globalSchemaIndex.stale = true`
   (NO DB read); the re-read runs lazily in `handleInput` when the index is
   sparse/stale. (`src/sql-autocomplete.js`: `stale`/`refreshing` fields + lazy
   trigger; `src/main.js`: `data_change` handler.)
2. **Awaited explorer render:** `renderMessages()` now `await`s
   `explorerUi.renderExplorer()` (was fire-and-forget → its `getDatabaseCatalog`
   ~30-query burst raced the next query). (`src/main.js`.)
3. **Test timeouts:** 30s ceiling, 15–20s inline (user directive: passing tests
   are sub-5s; anything slower is a deadlock or perf bug).
   (`playwright.config.mjs`, `tests/helpers.mjs`, `tests/specs/persistence.spec.mjs`.)
4. Reverted an earlier "defer schema refresh to turn-end" band-aid in favor of #1.

### 12.3 Refined diagnosis (VALIDATED from a caught hang — `/tmp/opencode/tc2-1.log`)
- **App-level serialization is CLEAN.** In a failing tool-call run:
  `fin start: 217` / `fin done: 217` (every finalize completes) and every
  `step gate-wait` has a matching `gate-pass` (the D3 gate never blocks). So the
  hang is **NOT** in the app-level gate.
- **The hang is inside the VFS.** The turn commits and the send button
  re-enables, but the post-turn `SELECT` acquires a `SHARED` lock and the VFS
  **strands it** — the last VFS events are two `lock SHARED` with **no matching
  unlock**. The wasm step is suspended in a lock acquisition that never returns.
- **Conclusion:** the remaining root cause is the **VFS lock protocol** stranding
  a read lock under JSPI re-entrancy — the `ifAvailable` silent-skip
  (`WebLocksMixin.js:209`) / shared per-file `lockState` (§4.1, §4.2).
  **The savepoint is the container, not the cause.**

### 12.4 Current test state (post app-fixes)
- **Stable:** boot-idempotency (3/3), vfs-contract (1/1), session-persistence,
  and the **plain fake-LLM turn** (no tool call).
- **~50% flaky:** the **tool-call turn** (`execute_sql` UDF → nested query inside
  the step) — the nested-UDF-query path that still hits the stranded lock.

### 12.5 Deep dive (DONE) — the VFS was a red herring
The deferred deep dive ran and **reframed the root cause**. It is NOT a VFS
lock-release line. Findings:

- **The stranded `lock SHARED` is a symptom, not the cause.** In `exclusive`
  policy the `access` Web Lock is *exclusive*, so the browser lock manager never
  fires a second callback while the first is held — there is no "orphaned
  release". A second `jLock(SHARED)` simply **queues** behind the first.
- **The real cause: SQLite's C core is not re-entrant on one `sqlite3*` handle.**
  No pthreads ⇒ its internal mutexes compile to no-ops. Two **independent**
  queries re-entering wasm concurrently (JSPI) clobber the Pager/B-tree/page-
  cache C state. The first query then never reaches `jUnlock(NONE)`, so the
  second's queued lock waits forever (`lockTimeout: Infinity`) → hang. A VFS-
  layer fix cannot help (the damage is inside wasm, below the VFS).
- **Confirmed from a caught hang** (`cl-run-2.log`): the post-turn queryAll
  overlapped the app's post-turn **catalog** burst (`getDatabaseCatalog`:
  `PRAGMA table_info` + `SELECT COUNT(*)` per table). Two `jLock(SHARED)` on the
  same file, no unlock between → the second queues → hang.

### 12.6 Repro / flags
- `window.__T261_TRACE = true` — `[ser]` gate traces (set via `addInitScript` pre-boot).
- `window.__T261_DISABLE_MUTEX = true` — disable the gate (reproduces BUG-008).
- `tests/probes/probe_toolcall_traced.mjs` — tool-call hang repro (turn + send-button
  wait + post-turn `SELECT` with 20s watchdog + VFS event dump).
- `npm test` — full 7-test suite (30s ceiling).

### 12.7 RESOLUTION — re-entrant serialization gate (implemented + verified)
**Fix (app layer, `src/harness.js` — our code, no vendor patch):** extend the
existing gate to serialize **independent** queries one-at-a-time while allowing
**nested** (UDF) queries. A plain statement mutex deadlocks the agent cascade
(nested UDF queries), so classification matters:

- A query is **nested** iff it is issued while a **UDF is executing**
  (`udfDepth > 0`). `create_function` is wrapped so each UDF callback runs with
  `udfDepth++` … `finally udfDepth--` (async, so it spans the UDF's awaits).
- **Independent** queries (`udfDepth === 0`) acquire a slot on an `entryQueue`
  (synchronous tail-swap before any await) on the generator's **first `next()`**,
  and release it in the generator's `finally` (after the vendor gen is finalized).
- **Why not `stepDepth`:** a top-level catalog *step* is in flight when an
  independent query starts, so `stepDepth > 0` misclassifies it as nested and
  lets it slip through unserialized → clobber (the residual ~25% flake). `udfDepth`
  is 0 there, so the query is correctly serialized.
- A non-fatal `console.warn` trips if a sibling nested query is already in flight
  at the same `udfDepth` (parallel nested → clobber risk; the app runs nested seq.).

**Verification:**
- Traced probe (`probe_toolcall_traced.mjs`): **12/12 clean** (was ~25% flaky after
  the first gate version, ~50% before any gate).
- Full 7-test suite: **7/7 green, twice** (16.1s / 15.9s); tool-call test 1.3s.

**Status: BUG-008 fixed.** Changes are in the working tree (uncommitted). The
vendor `WebLocksMixin.js` was NOT modified (the dedup idea was reviewed and
rejected — see §12.5; it drops the lock early and doesn't address C-state).

### 12.6 Repro / flags
- `window.__T261_TRACE = true` — `[ser]` gate traces (set via `addInitScript` pre-boot).
- `window.__T261_DISABLE_MUTEX = true` — disable the D3 gate (reproduces pre-gate behavior).
- `tests/probes/probe_toolcall_traced.mjs` — tool-call hang repro (turn + send-button
  wait + post-turn `SELECT` with 20s watchdog + VFS event dump).
- `npm test` — full 7-test suite (30s ceiling).

