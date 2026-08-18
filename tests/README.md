# Guardrails Harness (Ticket 26.1)

The safety net for the Ticket 26 re-plan and every ticket after it. A data
persistence app with zero automated tests is how silent data loss ships
(see `docs/archive/RETROSPECTIVE_TICKET_26.md`). **Nothing merges without `npm test`
green.**

## Run

```sh
npm test                 # all suites
npx playwright test tests/specs/persistence.spec.mjs   # one suite
```

Requirements: a running (or auto-started) Vite dev server on `:5174`, and a
JSPI-capable system browser — Chrome or Edge, launched with
`--js-flags=--experimental-wasm-jspi` (the config detects it; override with
`T261_CHANNEL=chrome|msedge`). Bundled Chromium cannot run JSPI.

Each test runs in a **fresh browser context = fresh IndexedDB = fresh agent
brain**, which both isolates tests and reproduces the fresh-boot layout the
BUG-008 no-op commit depended on.

## The suites

| Suite | Catches | How |
|---|---|---|
| `persistence.spec.mjs` | The BUG-008 class: silent data loss on refresh (the T26 retrospective's "BUG-010/011/012") | Create a session (and a fake-LLM turn) via the real UI → `page.reload()` → assert present in the dropdown **and** a direct `SELECT` **and** the IDB block dump; no duplicate session ids |
| `vfs-contract.spec.mjs` | No-op commits & seal-timing regressions at the VFS boundary | 5 canonical write patterns (autocommit INSERT; SAVEPOINT+INSERT+RELEASE; BEGIN IMMEDIATE…COMMIT; multi-statement txn; DDL in txn) → dump IDB blocks via a second read-only connection → assert the marker row is in a block at the committed metadata version, no `pendingVersion` left |
| `boot-idempotency.spec.mjs` | Boot mutating/losing user data (the T26 retrospective's "BUG-010/011" class) | 3 consecutive reloads; mid-boot hard kills (CDP `Target.closeTarget`) at staggered delays; boot over a stranded `_sessions_clean` (crashed-migration state) → schema + data intact, `integrity_check: ok`, no stranded temp tables |

### The durability boundary

The key idea from the BUG-008 post-mortem: **a row is durable only when it
is in IndexedDB, not when the WASM page cache holds it.** A no-op commit
(the pager never transitioning to a write transaction) passes every
same-connection read and fails the IDB dump. `idbDump()` in `helpers.mjs`
opens a second read-only IDB connection (the app's own is private to the
VFS) and searches the `blocks` store for a unique marker string.

IDB layout (see `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js`): database
`idb`, store `blocks` keyed `[path, -offset, version]`, store `metadata`
keyed by path → `{ name, fileSize, version, pendingVersion? }`. Lower
version = newer; a commit seals pages at the decremented `metadata.version`
and deletes superseded versions.

## VFS event log (visibility)

The VFS records every storage-level event in a ring buffer (last 5000),
exposed on the live handle: **`window.__agent.vfs.events`** (works in the
preview browser console and in tests). Instrumentation is logging-only —
it changes no VFS behavior (marked `T26.1` in the vendor file).

Event types, in the order a write transaction produces them:

| type | meaning |
|---|---|
| `open` | file opened (path, metadata version, fileSize) |
| `lock` / `unlock` | SQLite lock-level transitions (`lockType`: 0=NONE 1=SHARED 2=RESERVED 3=PENDING 4=EXCLUSIVE; `level` = level held before) |
| `txn-begin` | first write of a transaction — `pendingVersion` marker written to IDB |
| `write` | a page written to IDB (offset, version, size) |
| `seal` | commit — metadata sealed at the new version, superseded pages deleted |
| `recovery` | **crash recovery ran** — deleted in-flight blocks (also `console.log`'d as `[vfs] recovery`) |
| `rollback` | transaction rolled back (also `console.log`'d as `[vfs] rollback`) |

A healthy write statement looks like:
`lock(1) → lock(2) → lock(4) → txn-begin → write… → seal → unlock(1) → unlock(0)`.
A **no-op commit** is a statement that locks and unlocks with **no
`txn-begin`/`write`/`seal`** — the row only ever existed in the page cache.

Useful console one-liners:

```js
window.__agent.vfs.events.filter(e => e.type === 'recovery')   // crash-recovery deletions
window.__agent.vfs.events.filter(e => ['txn-begin','seal'].includes(e.type)) // commit flow
```

## Conventions (enforced by review + AGY sign-off)

- **No silent failure in data paths.** A data-path function must not
  `catch` a DB error and fabricate success (a default row, an empty list,
  "everything is fine"). Errors surface: throw, or at minimum
   `console.error`. This is how BUG-008's no-op commit became "the session
   just vanished" with no error anywhere (the T26 branch's `listSessions`
   swallowed the query error and fabricated a default session).
- **Never poll the DB mid-turn.** SQLite is single-threaded: a turn in
  flight (JSPI suspended on a fetch) blocks all other DB ops on the
  connection. Wait for turn completion on the DOM (chat bubbles), then
  query.
- **Probe code lives in `.mjs` modules** served by Vite
  (`tests/probes/*`), importable both from the harness and from the preview
  browser console (`import('/tests/probes/<name>.mjs?t=' + Date.now())`),
  matching the `docs/prototypes/*` convention.
- **Fresh context per test.** Don't share state between tests; a shared
  brain makes persistence assertions meaningless.
