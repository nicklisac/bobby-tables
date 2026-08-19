// Ticket 3 — rewind: the agent's DDL must actually be undone, and a real-turn
// rewind must also rewind the conversation (flag + hide, audit log preserved).
//
// Two bugs guarded here:
//  1. DDL no-op: the agent's execute_sql DDL path logged turn_ddl_log rows with
//     tableName/preImage NULL, so the inverse replay ran
//     `DROP TABLE IF EXISTS "null"` — agent CREATE/DROP TABLE turns were never
//     undone (the scratchpad path logged correctly; the agent path didn't).
//  2. Chat: rewind was data-only — the chat pane rendered straight from
//     `messages` and kept showing the rewound conversation. Now rows at/after
//     the rewind point are flagged `rewound = 1` (never deleted) and hidden
//     from the pane, v_active_context, and the compaction estimator.
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig, queryAll, queryValue } from '../helpers.mjs';

const FAKE_REPLY = 't3-rewind-ok-reply';

/** Fake LLM: first call issues `toolSql` via execute_sql, second replies. */
function routeToolTurn(page, toolSql) {
  let calls = 0;
  return page.route('**/chat/completions', (route) => {
    calls++;
    const body = calls === 1
      ? {
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'rw-1',
                type: 'function',
                function: { name: 'execute_sql', arguments: JSON.stringify({ query: toolSql }) },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }
      : {
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function bootFake(page) {
  await seedConfig(page, {
    provider: 'gemini',
    apiKey: 't3-rewind-fake-key',
    isConfigured: true,
    model: 'gemini-2.5-flash',
  });
  await bootPage(page);
}

/** Send a message, approve the write, wait for the final reply. */
async function sendApprovedTurn(page, text) {
  await page.fill('#user-input', text);
  await page.click('#send-btn');
  const approveBtn = page.locator('#messages button:has-text("Approve")').first();
  await approveBtn.waitFor({ timeout: 20_000 });
  await approveBtn.click();
  await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
  await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
}

/** Click the first user bubble's ⟲, accept the confirm, capture its text. */
async function rewindFirstTurn(page) {
  let dialogMsg = '';
  page.once('dialog', (d) => { dialogMsg = d.message(); d.accept(); });
  await page.locator('.message.user .rewind-btn').first().click();
  await page.locator('#messages .message.assistant').filter({ hasText: '⟲' }).first().waitFor({ timeout: 15_000 });
  return dialogMsg;
}

const TABLE_GONE = 'table gone';

test.describe('T3 rewind — agent DDL is undone, conversation is rewound', () => {
  test('agent CREATE TABLE turn: table is actually dropped on rewind; chat flagged, context cleared', async ({ page }) => {
    test.setTimeout(60_000);
    await routeToolTurn(page, 'CREATE TABLE rw_t (x INTEGER); INSERT INTO rw_t VALUES (42); SELECT * FROM rw_t');
    await bootFake(page);

    await sendApprovedTurn(page, 'rw message');

    // The DDL was logged with a REAL table name (the bug: it was null).
    const ddl = await queryAll(page, `SELECT table_name, substr(ddl_sql, 1, 30) FROM turn_ddl_log`);
    expect(ddl).toHaveLength(1);
    expect(ddl[0][0]).toBe('rw_t');
    expect(await queryValue(page, `SELECT COUNT(*) FROM rw_t`)).toBe(1);

    const dialogMsg = await rewindFirstTurn(page);
    // The confirm dialog counts the DDL (the bug: it said "no data changes").
    expect(dialogMsg).toContain('DDL statement');

    // Data: the created table is gone (the bug: it survived).
    expect(await queryValue(page, `SELECT COUNT(*) FROM rw_t`).catch(() => TABLE_GONE)).toBe(TABLE_GONE);

    // Audit log: rows are FLAGGED, never deleted.
    expect(await queryValue(page, `SELECT rewound FROM messages WHERE content = 'rw message'`)).toBe(1);
    expect(await queryValue(page, `SELECT COUNT(*) FROM messages WHERE COALESCE(rewound, 0) = 1`)).toBeGreaterThanOrEqual(3);

    // The marker is visible (not flagged) and tells the agent what happened.
    expect(await queryValue(page, `SELECT COUNT(*) FROM messages WHERE content LIKE '⟲%' AND COALESCE(rewound, 0) = 0`)).toBe(1);

    // Chat pane: the rewound bubbles are hidden — only the marker remains.
    expect(await page.locator('#messages .message.user').count()).toBe(0);
    expect(await page.locator('#messages .message').count()).toBe(1);

    // Agent context: the rewound conversation is gone from v_active_context.
    expect(await queryValue(page, `SELECT COUNT(*) FROM v_active_context WHERE content = 'rw message'`)).toBe(0);
    expect(await queryValue(page, `SELECT COUNT(*) FROM v_active_context WHERE content LIKE '⟲%'`)).toBe(1);
  });

  test('DROP TABLE with pre-image is restored on rewind (scratchpad path)', async ({ page }) => {
    test.setTimeout(60_000);
    await seedConfig(page, {
      provider: 'gemini',
      apiKey: 't3-rewind-fake-key',
      isConfigured: true,
      model: 'gemini-2.5-flash',
    });
    await bootPage(page);

    // Seed the victim table + row directly.
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      for await (const stmt of sqlite3.statements(db, 'CREATE TABLE drop_t (x INTEGER); INSERT INTO drop_t VALUES (7)')) {
        while (await sqlite3.step(stmt) !== 101 /* SQLITE_DONE */) { /* step */ }
      }
    });
    expect(await queryValue(page, `SELECT x FROM drop_t`)).toBe(7);

    // Drop it via the scratchpad — the path where DROP actually executes.
    // (The agent's execute_sql cannot DROP inside the UDF cascade: SQLite
    // returns SQLITE_LOCKED_TABLE for a schema change nested in a suspended
    // write statement — a pre-existing limitation, independent of rewind.)
    page.once('dialog', (d) => d.accept());
    await page.fill('#user-input', '!!DROP TABLE drop_t');
    await page.click('#send-btn');
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
    expect(await queryValue(page, `SELECT COUNT(*) FROM drop_t`).catch(() => TABLE_GONE)).toBe(TABLE_GONE);

    // The DDL log row carries the table name AND a pre-image.
    const ddl = await queryAll(page, `SELECT table_name, pre_image IS NOT NULL FROM turn_ddl_log`);
    expect(ddl).toHaveLength(1);
    expect(ddl[0][0]).toBe('drop_t');
    expect(ddl[0][1]).toBe(1);

    // Rewind the scratchpad command (its bubble's ⟲ → confirm → replay).
    page.once('dialog', (d) => d.accept());
    await page.locator('.message.user .rewind-btn').first().click();
    await page.locator('#messages .message.assistant').filter({ hasText: '⟲' }).first().waitFor({ timeout: 15_000 });

    // The drop is undone: table back, row back.
    expect(await queryValue(page, `SELECT x FROM drop_t`)).toBe(7);
  });

  test('real-turn rewind also undoes scratchpad commands issued after the point', async ({ page }) => {
    test.setTimeout(60_000);
    await page.route('**/chat/completions', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
    });
    await bootFake(page);

    // A plain turn (no data changes) — the rewind point.
    await page.fill('#user-input', 'hello');
    await page.click('#send-btn');
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });

    // A scratchpad command AFTER the point (write confirm → accept).
    page.once('dialog', (d) => d.accept());
    await page.fill('#user-input', '!!CREATE TABLE sp_t (x INTEGER)');
    await page.click('#send-btn');
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
    expect(await queryValue(page, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'sp_t'`)).toBe(1);

    // Rewind to before 'hello': the scratchpad command's bubble is hidden, so
    // its data must be undone too (the bug: only positive turn_ids replayed).
    await rewindFirstTurn(page);
    expect(await queryValue(page, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'sp_t'`)).toBe(0);
    expect(await page.locator('#messages .message.user').count()).toBe(0);
  });
});
