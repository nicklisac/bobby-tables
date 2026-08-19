// Ticket 16 repair — stale malformed tools rows must self-heal at boot.
//
// The T16 template-literal escaping hazard (backslash-escaped double quotes
// in a tool description) could persist a tools row whose schema is malformed
// JSON. The agent_think trigger runs json_group_array(json(schema)) FROM
// tools on EVERY turn, so one such row throws "malformed JSON" and breaks
// every turn in every session, regardless of LLM provider. The tools seed is
// INSERT OR IGNORE, so a corrupted row in an existing brain survives boot
// un-repaired — migrateToolsTable (harness boot, pre-SCHEMA_SQL) must delete
// the bad rows so the canonical schemas re-seed.
//
// This spec simulates the stale-brain state (corrupt a row, reload) and
// asserts: the next turn succeeds, the row is re-seeded valid, and VALID
// rows (including a user-customized tool) are left untouched.
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, seedConfig, queryAll, queryValue } from '../helpers.mjs';

const FAKE_REPLY = 't16-repair-ok-reply';

test.describe('T16 repair — stale malformed tools row self-heals at boot', () => {
  test('corrupted tools row: turn succeeds after reload, row re-seeded, valid rows kept', async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    await page.route('**/chat/completions', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
      });
    });
    await seedConfig(page, {
      provider: 'gemini',
      apiKey: 't16-repair-fake-key',
      isConfigured: true,
      model: 'gemini-2.5-flash',
    });

    // Fresh brain boots fine.
    await bootPage(page);

    // Simulate the stale-brain state: unescaped double quotes inside the
    // JSON string value (exactly what the broken intermediate wrote), plus a
    // VALID user-customized tool row that the repair must preserve.
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const bad = '{"type":"function","function":{"name":"search_documents","description":"FTS5 query: phrases in "double quotes" work","parameters":{"type":"object","properties":{}}}';
      for await (const stmt of sqlite3.statements(db, 'UPDATE tools SET schema = ? WHERE name = ?')) {
        sqlite3.bind_collection(stmt, [bad, 'search_documents']);
        await sqlite3.step(stmt);
      }
      const custom = JSON.stringify({
        type: 'function',
        function: { name: 'my_custom_tool', description: 'user added this', parameters: { type: 'object', properties: {} } },
      });
      for await (const stmt of sqlite3.statements(db, 'INSERT OR IGNORE INTO tools (name, schema) VALUES (?, ?)')) {
        sqlite3.bind_collection(stmt, ['my_custom_tool', custom]);
        await sqlite3.step(stmt);
      }
    });
    expect(await queryValue(page, 'SELECT COUNT(*) FROM tools WHERE json_valid(schema) = 0')).toBe(1);

    // Reload: boot must repair the row (migrateToolsTable + re-seed).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    await page.waitForSelector('#user-input:not([disabled])', { timeout: 15_000 });

    // The corrupted row is gone/re-seeded; no malformed rows remain.
    expect(await queryValue(page, 'SELECT COUNT(*) FROM tools WHERE json_valid(schema) = 0 OR json_type(schema) != \'object\'')).toBe(0);
    const searchSchema = await queryValue(page, `SELECT schema FROM tools WHERE name = 'search_documents'`);
    expect(searchSchema).toBeTruthy();
    expect(JSON.parse(searchSchema).function.name).toBe('search_documents');
    // The valid user-customized row survived the repair.
    expect(await queryValue(page, `SELECT COUNT(*) FROM tools WHERE name = 'my_custom_tool'`)).toBe(1);

    // The next turn succeeds end-to-end (previously: "malformed JSON").
    await page.fill('#user-input', 't16 repair message');
    await page.click('#send-btn');

    await page
      .locator('#messages .message.assistant')
      .filter({ hasText: FAKE_REPLY })
      .first()
      .waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
    expect(
      await page.locator('#messages .message.assistant').filter({ hasText: 'Turn failed' }).count(),
    ).toBe(0);
  });
});
