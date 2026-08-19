# Transaction Rules (Codified)

The transaction patterns that must never be re-introduced. These codify the
lessons from **BUG-012** (silent no-op commit — a savepoint-wrapped single
INSERT that writes zero pages to IDB) and **BUG-008** (JSPI re-entrancy hang —
two independent queries clobbering the C state). Enforced by **code review +
AGY sign-off**: nothing touches the data path without passing these.

> Background: `docs/archive/RETROSPECTIVE_TICKET_26.md` (BUG-012 post-mortem)
> and `docs/archive/BUG-008_INVESTIGATION.md` (§12, the re-entrancy root cause).

## The 6 Rules

### 1. Single statement → autocommit
Prefer autocommit for a single INSERT/UPDATE/DELETE — never wrap it in a
`SAVEPOINT`. A single statement is already atomic in autocommit; the savepoint
adds no atomicity and only changes the transaction pattern (that change is what
produced the BUG-012 no-op commit on the scrapped branch).

> **Re-verified 2026-08-18 (T26.2):** the 26.1 VFS contract probe runs this
> exact pattern (`SAVEPOINT` → single `INSERT` → `RELEASE`) against the live
> VFS and confirms it commits correctly (`inIdb=true`, at the committed
> version). So on the current VFS rule 1 is a **simplicity/robustness
> preference, not a hard correctness requirement** — autocommit is just the
> simplest, least-surprising pattern for a single row.

- ✅ `INSERT INTO sessions (id, name) VALUES (?, ?)` (autocommit)
- ⚠️ `SAVEPOINT sp; INSERT …; RELEASE sp;` for a single row (works, but adds no value)

### 2. Multi-statement atomic op → `BEGIN IMMEDIATE` … `COMMIT`
When an operation must be atomic across multiple statements, use
`BEGIN IMMEDIATE` … `COMMIT`. `IMMEDIATE` forces the write-transaction
transition **up front** — the exact transition the no-op commit skipped.
Savepoints are for nested / `ROLLBACK TO` semantics, not top-level app ops.

- ✅ `BEGIN IMMEDIATE; …multi-statement…; COMMIT;`
- ❌ `SAVEPOINT sp; …multi-statement…; RELEASE sp;` for a top-level op

### 3. Dev-mode read-back assertion
After every session write, assert the expected row state actually landed:
`SELECT 1 FROM sessions WHERE id = ?` → throw in dev if the state is wrong. A
no-op commit becomes a loud failure, not silent data loss. Implemented in
`src/schema.js` (`assertSessionState`) and wired into `createSession`,
`renameSession`, `deleteSession`, and `forkSession`.

### 4. Vendor VFS policy
No behavioral change to `vendor/wa-sqlite-jspi/*` without a 26.1 contract test
written **first** (red → green). The VFS is the boundary where silent data loss
lives; it is never changed speculatively.

### 5. Boot-migration discipline
Any schema migration is one-time, gated (PK check / `PRAGMA user_version`),
atomic, and has a recovery path. Never a per-boot `DROP`+`RENAME` of a user
table (BUG-010 — a reload between DROP and RENAME silently discards all custom
sessions).

### 6. JSPI re-entrancy (BUG-008)
Independent queries must not re-enter wasm concurrently on the single
`sqlite3*` handle. The C core is not re-entrant (no pthreads ⇒ internal mutexes
are no-ops), so two independent in-flight queries clobber the Pager/B-tree/
page-cache C state → hang. Nested (UDF) queries are fine; independent queries
are serialized. Enforced automatically by the gate in `src/harness.js`
(`udfDepth`-classified `entryQueue`). A query is *nested* iff issued while a UDF is
executing (`udfDepth > 0`) **or** inside a manual nested scope
(`manualDepth > 0`, via `agentApi.beginNestedScope()` / `endNestedScope()`) — the
scratchpad DDL path (`!!CREATE` / `!!DROP`) uses the manual scope so its inner
`logDDL` / drop-pre-image queries run inline instead of queueing behind their own
generator (BUG-014, a T26.1 gate regression). Do not bypass/remove the gate without a
26.1 regression test proving the alternative is safe.

## How these are verified
- **Read-back assertion** (rule 3): throws in dev when a session write does not
  land in the page cache (a swallowed SQL error, constraint violation, wrong
  table). Catches *immediate* write failures.
- **26.1 guardrails harness** (`npm test`): persistence, VFS-contract, and
  boot-idempotency suites. The **persistence test** (write → reload → assert
  present) is the guard for the no-op commit (rule 1's bug class): a no-op
  commit leaves the row in the page cache but not in IDB, so it survives an
  immediate read-back but is **lost on reload**. A re-entrancy regression
  (rule 6) fails the tool-call turn test.
- **VFS contract probe** (the no-op-commit discriminator): runs the exact
  BUG-012 trigger pattern (`SAVEPOINT` → single `INSERT` → `RELEASE`) and
  asserts the marker reaches IDB at the committed version. On the current VFS
  it **passes** (re-verified 2026-08-18 — the no-op commit does not reproduce);
  if a future VFS change re-introduces it, this probe goes red.
