// BUG-009 — a tool-call assistant row (content = '', tool_calls = <call>) used
// to render as '[empty]' because renderMessages never read tool_calls. It now
// renders a collapsible chip (tool name + a one-line summary, expandable to the
// full arguments). The tool RESULT renders as its own row below, so the turn
// reads user → [tool call] → [result] → answer.
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig } from '../helpers.mjs';

const FAKE_REPLY = 'bug009-ok-reply';

test.describe('BUG-009 — tool-call assistant row renders a chip, not [empty]', () => {
  test('execute_sql tool call shows a collapsible chip; no [empty]; expand reveals the SQL', async ({ page }) => {
    test.setTimeout(60_000);

    // Fake LLM: first call issues a read-only execute_sql (no approval needed),
    // second call replies. This produces a real tool-call assistant row + a tool
    // result row, then the final reply — the exact path that used to show [empty].
    let calls = 0;
    await page.route('**/chat/completions', (route) => {
      calls++;
      const body = calls === 1
        ? {
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 'tc-1',
                  type: 'function',
                  function: { name: 'execute_sql', arguments: JSON.stringify({ query: 'SELECT 1 AS one, 2 AS two' }) },
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

    await seedConfig(page, {
      provider: 'gemini',
      apiKey: 'bug009-fake-key',
      isConfigured: true,
      model: 'gemini-2.5-flash',
    });
    await bootPage(page);

    await page.fill('#user-input', 'run a query');
    await page.click('#send-btn');
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });

    // The tool-call chip is present (the fix) and shows the tool name.
    const chip = page.locator('#messages .toolcall-chip').first();
    await chip.waitFor({ timeout: 15_000 });
    expect(await chip.locator('.toolcall-name').textContent()).toBe('execute_sql');
    // The one-line summary shows the SQL.
    expect(await chip.locator('.toolcall-summary').textContent()).toContain('SELECT 1 AS one');

    // No assistant message renders as '[empty]' (the bug).
    expect(await page.locator('#messages .message.assistant').filter({ hasText: '[empty]' }).count()).toBe(0);

    // The tool RESULT renders as its own row below the chip.
    expect(await page.locator('#messages .message.tool').count()).toBe(1);

    // Expand the chip → the full arguments (the SQL) become visible.
    await chip.locator('summary').click();
    await expect(chip.locator('.toolcall-args pre')).toContainText('SELECT 1 AS one, 2 AS two');
  });
});
