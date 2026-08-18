# Ticket 26 Retrospective — What Broke, What We Got Wrong, and How I'd Do It

**Date:** 2026-08-17
**Scope:** branch `sql-refactor` (single commit `cfa67c9` on top of `main` @ `42e6ca2`), the BUG-010/011/012 debugging sessions, and a concrete re-plan for the next session.
**Trigger:** user request — "look at all the branch diff code and come to your own solution for how you would have done this ticket."

---

## 1. What the branch actually shipped (diff review)

`git diff main...sql-refactor`: 17 files, +1546/−1749, **one giant commit**.

| Change | Verdict |
|---|---|
| `src/utils.js` (new): centralized `escapeHtml`, `quoteIdent`, `execParams`, `queryAll/Rows/Row/Value` | **Good.** Pure dedup, no behavior change. |
| Module split: `main.js` 2,238 → ~640 lines; new `scratchpad.js`, `chat-render.js` | **Good.** Mechanical move. |
| 5 "SQL-native views" (`v_schema_catalog`, `v_turn_boundaries`, `v_tool_call_queries`, `v_grid_matrix`, `v_session_summary`) | **Vaporware.** No `CREATE VIEW` exists anywhere. They appear only in comments, in `DROP VIEW IF EXISTS` at boot, and in the Wayfinder map's verification claim. `explorer.js` still runs per-table `PRAGMA table_info` in a JS loop; `compaction.js` still walks token boundaries in JS. The "verification probe" never queried a single view. |
| `createSession` / `renameSession`: plain autocommit statement → **wrapped in `SAVEPOINT sess_sp`** | **The trigger.** This is the only transaction-pattern change in the branch, and it is the exact pattern that produces the captured no-op commit (see §2). A single INSERT is already atomic in autocommit — the savepoint added no atomicity value. |
| `deleteSession` / `forkSession`: sequential statements → savepoint-wrapped | Same pattern; multi-statement ops do need atomicity, but savepoints are the wrong tool here (see §4.3). |
| Boot step 9a: **every-boot** `DROP TABLE sessions` + `CREATE _sessions_clean` + `RENAME` (non-atomic batch) + orphan backfill | **BUG-010.** A reload between DROP and RENAME silently discards all custom sessions; the backfill then resurrects ghost "Session 1786…" rows from orphaned messages. |
| Vendor `IDBBatchAtomicVFS.js`: seal moved to `jUnlock(≤SHARED)` + new seal path in `jSync` | **Semantic change to vendor code with zero tests.** Changes *when* a write transaction's blocks become visible. No test, no note, buried in the giant commit. |
| `listSessions`: added `catch` that **swallows the query error and returns a fabricated default session** | **Anti-pattern.** Turns a DB failure into silent UI normalcy. This is how a no-op commit becomes "the session just vanished" with no error anywhere. |
| Verification: `docs/prototypes/ticket-26-compaction-probe.mjs` | Manual browser probe testing string utils + happy-path reads. **No persistence test, no reload test, no write-pattern test, no view test.** |
| Test infrastructure | **None.** No test script in `package.json`, no test dir. `playwright` is in devDependencies and unused. |

## 2. The bug chain (what actually broke)

1. **Ticket 26 commit** changes the session-write transaction pattern (savepoints), adds a per-boot destructive migration, and changes vendor VFS seal timing — in one un-bisectable commit, with no persistence test.
2. **User reports:** session created via UI vanishes on refresh; sometimes a duplicate same-id row with a default name; `REINDEX sessions` fails with `UNIQUE constraint failed`.
3. **Session 1 debugging** found a real bug (second concurrent VFS connection from config-save re-boot / HMR corrupting an in-flight transaction via crash-recovery) and fixed it (close-before-boot) — and **declared BUG-012 FIXED** without ever running the user's exact repro. The BUG_LOG itself flagged: *"A real message has never been used in a controlled repro. This is the missing repro."*
4. **User re-reports the same symptom.** Session 2 debugging (this branch, continued) then proved the actual row-loss mechanism at the VFS boundary:
   - The INSERT step of `createSession` performs **zero VFS I/O** — no SHARED/RESERVED lock, no `BEGIN_ATOMIC_WRITE` (op31), no write of the sessions page.
   - The `RELEASE` commits with **zero dirty pages** (`EXCLUSIVE → COMMIT_PHASETWO → unlock`, no seal, no sync).
   - The pager **never transitioned to a write transaction**, so the page edit lives only in the in-memory page cache and is lost on refresh.
   - The bug is **state-dependent**: reproduced only on the original fresh-boot DB layout; never on the modified DB (even after deleting back to 1 session).
5. A **secondary defect** was found: table reads hang (main thread free, query pending, persists across reloads). Web Locks, IDB, and VFS file state were all ruled out → suspected JSPI suspension/resume failure in the WASM read path.

**Attribution:** the savepoint wrapper is the leading trigger — it is the only transaction-pattern change in the branch, and the failure mode (skipped write-transaction transition) is exactly the difference the wrapper introduces. Attribution is strong but **not 100%**: the repro state was destroyed (test sessions created/deleted) before a plain-autocommit-INSERT control could be run on the original DB layout.

## 3. Our mistakes (honest list)

### Execution mistakes (how the ticket was done)
1. **One giant commit** mixing pure refactor + behavior change + migration change + vendor change → un-bisectable.
2. **No persistence test before or after.** A data-persistence app with zero automated tests is how silent data loss ships. The single test that would have caught everything: *create session → reload → assert row present.*
3. **Claimed features that don't exist** (the 5 views) in the Wayfinder map, with a "verification" that didn't verify them.
4. **Savepoint-wrapping single statements** — a transaction-pattern change made for no benefit, on a WASM build whose savepoint/commit path is unproven.
5. **Per-boot destructive migration** (DROP + RENAME) with no gate, no atomicity, no recovery path.
6. **Vendor VFS semantic change** without a test or a note.
7. **Error-swallowing in data paths** (`listSessions` fabricating success).

### Debugging mistakes (how we chased it)
8. **Declared FIXED without the user's exact repro.** A fix is not done until the reported symptom is reproduced, then shown gone.
9. **No reproducible baseline, no state snapshots.** We debugged on the user's live, already-corrupted DB, then mutated it (test sessions) and **destroyed the only state that reproduced the bug.** Every experiment should have been reversible: dump IDB (blocks + metadata) to disk before, restore between.
10. **Instrumentation with unverified cost.** The first logger (flush every 40 events, re-reading ~900KB of sessionStorage) caused 15-second main-thread blocks that we initially misread as app bugs. Rule: validate any instrumentation against a null baseline (on vs off on a known-good op) *before* trusting any observation.
11. **Didn't isolate the stack early.** The no-op commit means the *pager inside WASM* failed to begin a write transaction. The single most discriminating experiment we never ran: **run the same SQL against `MemoryVFS`** (the harness already has the fallback!) or a stock sqlite build. That would have told us in ~10 minutes whether this is an IDB-VFS bug or a WASM/JSPI bug — halving the search space.
12. **Chased theories before pinning the mechanism.** Nested savepoints, page-version skew, two connections… The data-boundary questions — *"does the row reach IDB?"* (5-minute IDB diff) and *"what does the VFS see during the INSERT step?"* (→ zero I/O → no-op commit) — would have pinned the mechanism in an hour. We spent days before capturing that trace.
13. **Destructive IDB ops from a live page.** `deleteDatabase` from a wedged page deadlocked the IDB (and blocked subsequent opens). Destructive IDB ops must run from a page with **no** IDB connection, with a recovery page ready (we had `public/bug12-blank.html` and still got blocked).
14. **Never reduced the "state-dependent" state to a minimal trigger.** We knew it needed "the original fresh-boot layout" but never captured *what specifically* in that state mattered (page count, version magnitude, specific page contents).

## 4. How I would have done this ticket (my solution)

### 4.1 Phase 0 — Guardrails FIRST (before any refactor)
1. **Persistence regression test (Playwright):** boot app → create session via UI → `page.reload()` → assert session present in dropdown AND in a direct `SELECT`. This one test catches the entire bug class.
2. **VFS contract probe (headless or browser):** run the canonical write patterns — autocommit INSERT; `SAVEPOINT`+INSERT+`RELEASE`; `BEGIN IMMEDIATE`…`COMMIT`; multi-statement txn; DDL in txn — and after each, **assert the committed page set in IDB** (dump blocks, check the table page's newest version contains the row). Catches no-op commits and seal-timing regressions.
3. **Boot idempotency test:** boot N times, including simulated mid-boot kills (reload between migration steps) → assert schema + data intact. Catches BUG-010/011-class bugs.
4. **No-silent-failure rule:** data-path functions must not `catch` and fabricate success. Errors surface (console.error minimum, throw preferred).

### 4.2 Phase 1 — Split the ticket into 4 independent, testable PRs
- **PR1: utils + module split** (pure code move, zero behavior change). Gate: build + persistence test green.
- **PR2: SQL-native views — actually create them**, one commit per view if needed, with a probe that `SELECT`s each view and fails if it's missing. Only claim in the Wayfinder map what the probe proves.
- **PR3: Boot migration hardening:** one-time, gated (PK check or `PRAGMA user_version`), atomic with a recovery path, never per-boot, never DROP a user table without a marker gate.
- **PR4: Session transaction patterns** (the §4.3 rules).

Each PR merges with the persistence test green. If a bug appears, `git bisect` finds the PR in ≤2 runs.

### 4.3 Transaction-pattern rules (documented in-repo, enforced by review)
1. **Single statement → autocommit.** Never wrap a single INSERT/UPDATE in a savepoint. It is already atomic; the wrapper only changes the transaction pattern.
2. **Multi-statement atomic op → `BEGIN IMMEDIATE` … `COMMIT`.** `IMMEDIATE` forces the write-transaction transition **up front** — exactly the transition the no-op commit skipped. Savepoints are for nested/`ROLLBACK TO` semantics, not top-level app ops.
3. **Dev-mode read-back assertion** after every session write: `SELECT 1 FROM sessions WHERE id = ?` — if missing, throw (in dev) instead of silently continuing.
4. **Vendor VFS policy:** no behavioral change without a contract test written first (red → green). The seal-timing change gets its own commit, its own test, or it gets reverted.

### 4.4 How I would have debugged the bug (the "next session" playbook)
1. **Controlled repro first:** fresh browser profile, fresh IDB, scripted: create session → snapshot IDB → refresh → assert. Record the IDB dump at each step.
2. **`git bisect` with the persistence test** across `main`…`cfa67c9` (or within the working tree) — the savepoint wrapper or the VFS seal change should surface in a few runs.
3. **Isolate the stack:** run the trigger SQL against `MemoryVFS` vs `IDBBatchAtomicVFS`; if possible against a stock (non-JSPI) sqlite build. Pin: IDB-VFS bug vs WASM/JSPI bug vs SQL-pattern bug.
4. **Then instrument** — with a validated null baseline (measure on vs off on a known-good op before trusting observations).
5. **Never mutate the repro state** — snapshot/restore between every experiment.
6. **Destructive IDB ops only from a connection-free page**, with the recovery page ready.

### 4.5 The concrete fixes I'd ship now (given what we know)
1. `createSession`: **revert to the plain autocommit INSERT** (removes the trigger pattern from the user's exact flow).
2. `renameSession`: same — single UPDATE, autocommit.
3. `deleteSession`, `forkSession`: `BEGIN IMMEDIATE` … `COMMIT` instead of savepoints.
4. Boot 9a (working-tree fix): switch its `SAVEPOINT sessions_migrate` to `BEGIN IMMEDIATE` … `COMMIT` for consistency (low risk — legacy-brain path only — but the rule is the rule).
5. `listSessions`: stop fabricating; surface the error.
6. Add the Phase-0 tests (persistence + VFS contract + boot idempotency).
7. **Report upstream** (wa-sqlite maintainer): the no-op commit (savepoint INSERT skipping the write-transaction transition) + the JSPI table-read hang, with the unified `__b12uni` VFS event trace. The trace format was built for exactly this.
8. Keep the close-before-boot fix (real bug, real fix) — but mark BUG-012 as **two bugs**: the double-boot corruption (fixed) and the no-op commit (open).

## 5. Status of the working tree (for the next session)
- Uncommitted: BUG-010/011 fixes (harness boot), close-before-boot (main.js), **BUG-012 temporary instrumentation in `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js`** (gated by `window.__b12off`; remove when diagnosis closes), BUG_LOG updates.
- The live preview tab's DB was cleared by the user 2026-08-17; the table-read hang persisted across that clear + reload → treat the hang as independent of DB contents (or triggered by the boot path itself).
- `docs/BUG_LOG.md` BUG-012 entry now carries the full session-2 record (no-op commit evidence, state-dependence, hang analysis, options).
