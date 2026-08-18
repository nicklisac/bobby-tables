// Ticket 26.1 — Persistence regression suite.
//
// The single test that would have caught the BUG-008 class (silent data
// loss on refresh; the T26 retrospective's "BUG-010/011/012"): create
// something through the real UI, refresh, assert it is still there — in the
// dropdown, in a direct SELECT, and (the durability boundary) in IndexedDB
// itself.
import { test, expect } from '@playwright/test';
import {
  bootPage,
  waitAgent,
  queryAll,
  idbDump,
  seedConfig,
  createSessionViaUi,
} from '../helpers.mjs';

const FAKE_REPLY = 'T261 fake reply: persistence check.';
const MSG_TEXT = 'T261 persistence ping';

test.describe('Persistence — the BUG-008 class (silent data loss on refresh)', () => {
  test('session created via UI survives reload: dropdown + SELECT + IDB, no duplicate ids', async ({
    context,
    page,
  }) => {
    const name = `T261 Session ${Date.now().toString(36)}`;
    await bootPage(page);

    // The user's exact repro: create a session through the real UI path
    // (#btn-new-session → prompt() → createSession → setActiveSession).
    const sessionId = await createSessionViaUi(page, name);
    expect(sessionId).not.toBe('default');

    // 1. Same-connection read (what the UI sees)…
    expect(await queryAll(page, 'SELECT id FROM sessions WHERE id = ?', [sessionId])).toHaveLength(1);
    // 2. …and the durability boundary: the row must be in IDB, not only in
    //    the WASM page cache (a no-op commit passes (1) and fails (2)).
    const dump = await idbDump(page, name);
    expect(dump.markerFound, 'session row must have reached IDB before reload').not.toBeNull();
    // 3. No duplicate ids (the T26 "BUG-010" ghost "Session 1786…" rows).
    expect(
      await queryAll(page, 'SELECT id, COUNT(*) c FROM sessions GROUP BY id HAVING c > 1'),
    ).toHaveLength(0);

    // ── The refresh ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    // Present in the session list after reload…
    const reloaded = page.locator(`#session-list .session-item[data-session-id="${sessionId}"]`);
    await expect(reloaded).toBeVisible();
    expect(await reloaded.getAttribute('data-session-name')).toBe(name);
    // …and in a direct SELECT after reload.
    const rows = await queryAll(page, 'SELECT id, name FROM sessions WHERE id = ?', [sessionId]);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe(name);
    // …and still exactly one row with that id (no duplicate resurrection).
    expect((await queryAll(page, 'SELECT COUNT(*) FROM sessions WHERE id = ?', [sessionId]))[0][0]).toBe(1);
  });

  test('session + fake-LLM turn survive reload; no duplicate ids', async ({ context, page }) => {
    const name = `T261 Turn ${Date.now().toString(36)}`;
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
      apiKey: 't261-fake-key',
      isConfigured: true,
      model: 'gemini-2.5-flash',
    });

    await bootPage(page);
    const sessionId = await createSessionViaUi(page, name);

    await page.fill('#user-input', MSG_TEXT);
    await page.click('#send-btn');

    await page
      .locator('#messages .message.assistant')
      .filter({ hasText: FAKE_REPLY })
      .first()
      .waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });

    // Turn committed — DB assertions.
    const msgs = await queryAll(
      page,
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id',
      [sessionId],
    );
    expect(msgs.some((r) => r[0] === 'user' && r[1] === MSG_TEXT)).toBe(true);
    expect(msgs.some((r) => r[0] === 'assistant' && r[1] === FAKE_REPLY)).toBe(true);
    // The turn's rows must have reached IDB.
    expect((await idbDump(page, MSG_TEXT)).markerFound, 'turn rows must have reached IDB').not.toBeNull();

    // ── The refresh ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    const msgs2 = await queryAll(
      page,
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id',
      [sessionId],
    );
    expect(msgs2.some((r) => r[0] === 'user' && r[1] === MSG_TEXT)).toBe(true);
    expect(msgs2.some((r) => r[0] === 'assistant' && r[1] === FAKE_REPLY)).toBe(true);
    expect(
      await queryAll(page, 'SELECT id, COUNT(*) c FROM sessions GROUP BY id HAVING c > 1'),
    ).toHaveLength(0);
  });

  test('tool-call turn (execute_sql UDF: nested queries mid-step) survives reload', async ({
    context,
    page,
  }) => {
    // Regression guard for the BUG-008 fix design: the agent cascade runs JS
    // UDFs (ask_llm → execute_tool → run_dynamic_sql) INSIDE sqlite3.step(),
    // and those UDFs issue nested queries on the same connection. A
    // statement-lifetime mutex deadlocks here on the first tool-call turn;
    // the step/finalize serialization must not.
    const TOOL_PROBE = 't261_tool_probe';
    let llmCalls = 0;
    await page.route('**/chat/completions', (route) => {
      llmCalls++;
      const body = llmCalls === 1
        ? {
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 'call_t261_1',
                  type: 'function',
                  function: { name: 'execute_sql', arguments: JSON.stringify({ query: `SELECT 1 AS ${TOOL_PROBE}` }) },
                }],
              },
            }],
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await seedConfig(page, {
      provider: 'gemini',
      apiKey: 't261-fake-key',
      isConfigured: true,
      model: 'gemini-2.5-flash',
    });

    const name = `T261 Tool ${Date.now().toString(36)}`;
    await bootPage(page);
    const sessionId = await createSessionViaUi(page, name);

    await page.fill('#user-input', MSG_TEXT);
    await page.click('#send-btn');

    await page
      .locator('#messages .message.assistant')
      .filter({ hasText: FAKE_REPLY })
      .first()
      .waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });

    const msgs = await queryAll(
      page,
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id',
      [sessionId],
    );
    expect(msgs.some((r) => r[0] === 'tool' && String(r[1]).includes(TOOL_PROBE)),
      'tool result row from execute_sql must exist').toBe(true);
    expect(msgs.some((r) => r[0] === 'assistant' && r[1] === FAKE_REPLY)).toBe(true);
    expect((await idbDump(page, MSG_TEXT)).markerFound, 'turn rows must have reached IDB').not.toBeNull();

    // ── The refresh ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    const msgs2 = await queryAll(
      page,
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id',
      [sessionId],
    );
    expect(msgs2.some((r) => r[0] === 'tool' && String(r[1]).includes(TOOL_PROBE)),
      'tool result row must survive reload').toBe(true);
    expect(msgs2.some((r) => r[0] === 'assistant' && r[1] === FAKE_REPLY)).toBe(true);
    expect(
      await queryAll(page, 'SELECT id, COUNT(*) c FROM sessions GROUP BY id HAVING c > 1'),
    ).toHaveLength(0);
  });
});
