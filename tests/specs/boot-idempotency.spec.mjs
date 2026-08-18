// Ticket 26.1 — Boot idempotency suite.
//
// Booting the app must never mutate or lose user data: N consecutive boots
// (including boots that start over a half-finished previous boot) must
// leave schema + data intact, with no stranded migration temp tables and
// integrity_check ok. This is the T26 retrospective's "BUG-010/011" class
// (the per-boot DROP+RENAME sessions migration that discarded custom
// sessions on reload).
import { test, expect } from '@playwright/test';
import {
  bootPage,
  waitAgent,
  queryAll,
  hardKill,
  createSessionViaUi,
} from '../helpers.mjs';

const SEED_MSG = 'T261 boot idempotency seed';

/**
 * Boot, create a session via the UI, and seed one message into it (cascade
 * suppressed — the app's own pattern for non-cascade inserts). Returns the
 * session id.
 */
async function seedData(page, name) {
  await bootPage(page);
  const sessionId = await createSessionViaUi(page, name);
  await page.evaluate(
    async ([sid, msg]) => {
      const { sqlite3, db } = window.__agent;
      const { setSuppressCascade } = await import('/src/schema.js');
      await setSuppressCascade(sqlite3, db, true);
      try {
        for await (const stmt of sqlite3.statements(
          db,
          'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
        )) {
          sqlite3.bind_collection(stmt, [sid, 'user', msg]);
          await sqlite3.step(stmt);
        }
      } finally {
        await setSuppressCascade(sqlite3, db, false);
      }
    },
    [sessionId, SEED_MSG],
  );
  return sessionId;
}

const assertIntact = async (page, sessionId, label) => {
  expect(await queryAll(page, 'SELECT id FROM sessions WHERE id = ?', [sessionId]),
    `${label}: session lost`).toHaveLength(1);
  const msgCount = (
    await queryAll(page, 'SELECT COUNT(*) FROM messages WHERE session_id = ? AND content = ?',
      [sessionId, SEED_MSG])
  )[0][0];
  expect(msgCount, `${label}: seed message lost`).toBe(1);
  expect(await queryAll(page, 'PRAGMA integrity_check'), `${label}: integrity`).toEqual([['ok']]);
};

test.describe('Boot idempotency — the T26 "BUG-010/011" class (boot mutates user data)', () => {
  test('3 consecutive reloads: schema + data intact, no stranded temp tables', async ({
    context,
    page,
  }) => {
    const name = `T261 Boot ${Date.now().toString(36)}`;
    const sessionId = await seedData(page, name);

    for (let i = 1; i <= 3; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitAgent(page);
      await assertIntact(page, sessionId, `reload ${i}`);
      // No stranded migration temp tables (the T26 "BUG-010" intermediate state).
      expect(
        await queryAll(page, `SELECT name FROM sqlite_master WHERE name LIKE '%\\_clean%' ESCAPE '\\'`),
        `reload ${i}: stranded *_clean table`,
      ).toHaveLength(0);
    }
  });

  test('mid-boot kills at staggered delays: full boot recovers with zero data loss', async ({
    context,
  }) => {
    const name = `T261 Kill ${Date.now().toString(36)}`;
    let page = await context.newPage();
    const sessionId = await seedData(page, name);
    await page.close();

    // Kill points span the boot phases (WASM boot → schema/migration writes
    // → post-boot setup); exact landing is machine-dependent, so several are
    // used. A kill that lands after boot completes still exercises a
    // mid-operation kill, which must also be lossless.
    for (const delay of [300, 1500, 2500]) {
      page = await context.newPage();
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(delay);
      await hardKill(page);

      // Full boot on the same context (same IDB) must recover.
      page = await context.newPage();
      await bootPage(page);
      await assertIntact(page, sessionId, `mid-boot kill @ ${delay}ms`);
    }
  });

  test('boots cleanly over a stranded _sessions_clean (crashed-migration state)', async ({
    context,
    page,
  }) => {
    const name = `T261 Stranded ${Date.now().toString(36)}`;
    const sessionId = await seedData(page, name);

    // Simulate the crashed per-boot migration's intermediate state: the
    // clean-copy table exists alongside the live one (the state between the
    // buggy DROP+CREATE and RENAME).
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      for await (const stmt of sqlite3.statements(
        db,
        'CREATE TABLE _sessions_clean AS SELECT * FROM sessions',
      )) {
        await sqlite3.step(stmt);
      }
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    // Boot succeeded, data intact, integrity ok.
    await assertIntact(page, sessionId, 'stranded _sessions_clean boot');
    // The boot must not have created additional temp tables.
    expect(
      await queryAll(page, `SELECT name FROM sqlite_master WHERE name LIKE '%\\_clean%' ESCAPE '\\'`),
    ).toEqual([['_sessions_clean']]);
  });
});
