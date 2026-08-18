// Ticket 26.5 (subsystem 5) — differential output-equality probe: the
// refactored listSessions (v_session_summary) must return exactly what the
// pre-T26.5 raw-`sessions` listSessions returned.
//
// Oracle: the old listSessions, verbatim (raw `sessions` scan + the display
//   name normalization + the seen-set dedup).
// Actual: the T26.5 listSessions (v_session_summary base fields + the same
//   display-name normalization; the view's GROUP BY makes the dedup a no-op).
//
// The seed covers the normalization branches (normal / padded / empty /
// whitespace names) and the ordering (updated_at DESC, created_at DESC) via
// controlled timestamps, alongside the always-present 'default' session.
//
// A dedicated set of session ids isolates the seed; cascade/capture are
// suppressed and the seed is removed in `finally`.
//
// Run from the harness (tests/specs/t26.5-sessions.spec.mjs) or the preview
// console:
//   import('/tests/probes/t26.5-sessions.mjs?t=' + Date.now())
//     .then(m => m.runT265SessionsProbe(window.__agent.sqlite3, window.__agent.db))

import { queryAll } from '../../src/schema.js';
import { listSessions } from '../../src/schema.js';

const IDS = ['t265_s1', 't265_s2', 't265_s3', 't265_s4'];

// [id, name, description, created_at, updated_at]
const SEED = [
  ['t265_s1', 'Alpha', '', '2026-01-01 00:00:00', '2026-01-05 00:00:00'],
  ['t265_s2', '  Beta  ', 'beta desc', '2026-01-02 00:00:00', '2026-01-04 00:00:00'],
  ['t265_s3', '', null, '2026-01-03 00:00:00', '2026-01-06 00:00:00'],
  ['t265_s4', '   ', 'd4', '2026-01-04 00:00:00', '2026-01-03 00:00:00'],
];

/** The pre-T26.5 listSessions, verbatim (raw `sessions` scan + normalization). */
async function oracleListSessions(sqlite3, db) {
  const rows = await queryAll(sqlite3, db,
    `SELECT id, name, COALESCE(description, ''), created_at, updated_at
     FROM sessions ORDER BY updated_at DESC, created_at DESC`);
  const sessions = [];
  const seen = new Set();
  for (const [id, rawName, description, created_at, updated_at] of rows) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = (rawName && rawName.trim()) ? rawName.trim() : (id === 'default' ? 'Default Session' : 'Untitled Session');
    sessions.push({ id, name, description, created_at, updated_at });
  }
  return sessions;
}

export async function runT265SessionsProbe(sqlite3, db) {
  const R = { ok: false, steps: {} };
  try {
    await queryAll(sqlite3, db, [
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_capture'`,
    ].join('; '));

    for (const [id, name, description, createdAt, updatedAt] of SEED) {
      await queryAll(sqlite3, db,
        `INSERT INTO sessions (id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`, [id, name, description, createdAt, updatedAt]);
    }

    const oracle = await oracleListSessions(sqlite3, db);
    const actual = await listSessions(sqlite3, db);

    R.steps.arrayEquality = {
      ok: JSON.stringify(oracle) === JSON.stringify(actual),
      oracle,
      actual,
    };

    // Normalization + ordering spot-checks on the seeded (non-default) rows.
    const byId = Object.fromEntries(actual.map((s) => [s.id, s]));
    const order = IDS.map((id) => actual.findIndex((s) => s.id === id));
    const sortedIds = [...order].sort((a, b) => a - b).map((i) => actual[i].id);
    R.steps.spotChecks = {
      ok:
        byId.t265_s1?.name === 'Alpha' &&              // normal
        byId.t265_s2?.name === 'Beta' &&               // padded → trimmed
        byId.t265_s3?.name === 'Untitled Session' &&   // empty → fallback
        byId.t265_s4?.name === 'Untitled Session' &&   // whitespace → fallback
        byId.t265_s3?.description === '' &&            // NULL → COALESCE ''
        byId.t265_s2?.description === 'beta desc' &&
        JSON.stringify(sortedIds) === JSON.stringify(['t265_s3', 't265_s1', 't265_s2', 't265_s4']),
      names: { s1: byId.t265_s1?.name, s2: byId.t265_s2?.name, s3: byId.t265_s3?.name, s4: byId.t265_s4?.name },
      order: sortedIds,
    };

    R.ok = R.steps.arrayEquality.ok && R.steps.spotChecks.ok;
    return R;
  } finally {
    for (const id of IDS) {
      await queryAll(sqlite3, db, `DELETE FROM sessions WHERE id = ?`, [id]).catch(() => {});
    }
    await queryAll(sqlite3, db, [
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '0' WHERE key = 'suppress_capture'`,
    ].join('; ')).catch(() => {});
  }
}
