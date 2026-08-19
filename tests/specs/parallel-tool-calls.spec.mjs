// BUG-019 — parallel tool calls: an assistant message carrying N tool calls
// used to execute only the FIRST ($[0] in the execute_tool trigger). The other
// N-1 calls were never run and their ids were left orphaned; the boot repair
// then filled each with a "Turn interrupted — tool result lost" placeholder on
// reload (the production symptom: 10 placeholders in a chat whose model had
// batched calls).
//
// The fix: execute_tool iterates the whole array (json_each) and agent_think
// fires exactly once per batch — when the LAST sibling result lands.
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig, queryAll } from '../helpers.mjs';

const FAKE_REPLY = 'bug019-ok-reply';

test.describe('BUG-019 — parallel tool calls all execute; the cascade thinks once', () => {
  test('3 parallel execute_sql calls → 3 result rows, 2 LLM calls, no orphans (survives reload)', async ({ page }) => {
    test.setTimeout(60_000);

    // Fake LLM: call #1 issues THREE parallel read-only execute_sql calls in a
    // single assistant message; call #2 (expected after the whole batch lands)
    // replies. If the cascade thinks per-row instead of per-batch, the counter
    // exceeds 2 and the final-reply shape repeats.
    let calls = 0;
    await page.route('**/chat/completions', (route) => {
      calls++;
      const body = calls === 1
        ? {
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'p1', type: 'function', function: { name: 'execute_sql', arguments: JSON.stringify({ query: 'SELECT 101 AS v' }) } },
                  { id: 'p2', type: 'function', function: { name: 'execute_sql', arguments: JSON.stringify({ query: 'SELECT 202 AS v' }) } },
                  { id: 'p3', type: 'function', function: { name: 'execute_sql', arguments: JSON.stringify({ query: 'SELECT 303 AS v' }) } },
                ],
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

    await seedConfig(page, {
      provider: 'gemini',
      apiKey: 'bug019-fake-key',
      isConfigured: true,
      model: 'gemini-2.5-flash',
    });
    await bootPage(page);

    await page.fill('#user-input', 'run three queries');
    await page.click('#send-btn');
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });

    // The cascade thought exactly twice: the initial call + ONE call after the
    // whole batch landed (not once per result row — a per-row think would make
    // this 4).
    expect(calls).toBe(2);

    // All three calls executed, each with its own result row.
    const toolRows = await queryAll(page,
      `SELECT tool_call_id, content FROM messages WHERE role = 'tool' ORDER BY id`);
    expect(toolRows.map((r) => r[0]).sort()).toEqual(['p1', 'p2', 'p3']);
    const all = toolRows.map((r) => String(r[1])).join(' ');
    expect(all).toContain('101');
    expect(all).toContain('202');
    expect(all).toContain('303');

    // No orphaned tool_call ids (the pre-fix state: p2/p3 had no row).
    const orphans = await queryAll(page, `
      SELECT json_extract(tc.value, '$.id')
      FROM messages m
      CROSS JOIN json_each(CASE WHEN json_valid(m.tool_calls) THEN m.tool_calls ELSE '[]' END) tc
      WHERE m.role = 'assistant'
        AND m.tool_calls IS NOT NULL
        AND json_extract(tc.value, '$.id') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM messages t
          WHERE t.role = 'tool' AND t.tool_call_id = json_extract(tc.value, '$.id')
        )
    `);
    expect(orphans).toEqual([]);

    // Reload: the rows persist and the boot repair adds no placeholders.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready));
    const after = await queryAll(page,
      `SELECT tool_call_id FROM messages WHERE role = 'tool' ORDER BY id`);
    expect(after.map((r) => r[0]).sort()).toEqual(['p1', 'p2', 'p3']);
    const repaired = await queryAll(page,
      `SELECT COUNT(*) FROM messages WHERE content LIKE '%Turn interrupted%'`);
    expect(repaired[0][0]).toBe(0);
  });
});
