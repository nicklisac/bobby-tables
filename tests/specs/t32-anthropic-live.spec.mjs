// T32 — LIVE Anthropic-framing probe against a local Anthropic-compatible
// endpoint (LM Studio). This is the acceptance probe for the Anthropic
// Messages API framing: it drives a REAL turn through the app's actual path
// (boot → send → performLLMCall → registry → anthropic → the endpoint) and
// asserts the framing is correct end-to-end:
//   - the request is accepted (x-api-key + anthropic-version headers, top-level
//     system + max_tokens body),
//   - SSE content streams (content_block_delta → token events → non-empty content),
//   - usage maps to prompt_tokens (message_start.input_tokens) +
//     completion_tokens (message_delta.output_tokens) on the assistant row.
//
// The endpoint is a local dev server (not in CI), so the whole file SKIPS when
// it's unreachable. Override with LM_ANTHROPIC_URL / LM_ANTHROPIC_MODEL.
import { test, expect } from '@playwright/test';
import { bootPage, queryAll } from '../helpers.mjs';

const LM_URL = (process.env.LM_ANTHROPIC_URL || 'http://192.168.18.52:1234').replace(/\/+$/, '');
const LM_MODEL = process.env.LM_ANTHROPIC_MODEL || 'gemma-4-e4b-it';

// Lightweight reachability check (GET /v1/models — does NOT run the model).
async function endpointReachable() {
  try {
    const ctrl = AbortSignal.timeout(10_000);
    const r = await fetch(`${LM_URL}/v1/models`, { headers: { 'x-api-key': 'lmstudio' }, signal: ctrl });
    return r.ok;
  } catch {
    return false;
  }
}

test.describe('T32 — live Anthropic framing (LM Studio)', () => {
  test.beforeAll(async () => {
    // Manual-only probe: it drives a REAL turn against a local endpoint, which
    // is slow and flaky under headless Playwright (the turn can outlive the
    // rig's patience even though it completes fine in a real browser). Keep it
    // OUT of the regular suite; run it on demand with RUN_LIVE_PROBE=1.
    if (process.env.RUN_LIVE_PROBE !== '1') {
      test.skip(true, 'manual-only live probe — set RUN_LIVE_PROBE=1 to run');
      return;
    }
    test.skip(!(await endpointReachable()), `LM Studio Anthropic endpoint not reachable at ${LM_URL}`);
  });

  // Seed the active profile as an Anthropic provider pointed at the local
  // endpoint (base URL with /v1 — the registry appends /messages).
  const seedAnthropicProfile = (page) =>
    page.addInitScript(([url, model]) => {
      const id = 'probe-anthropic';
      localStorage.setItem('sql-agent-providers', JSON.stringify({
        profiles: [{
          id, name: 'LM Anthropic', provider: 'anthropic', url, model,
          apiKey: 'lmstudio', contextWindow: '4096', maxTokens: '',
        }],
        activeId: id,
      }));
    }, [`${LM_URL}/v1`, LM_MODEL]);

  test('a turn streams content and maps Anthropic usage to the assistant row', async ({ page }) => {
    seedAnthropicProfile(page);
    await bootPage(page);

    await page.fill('#user-input', 'Just reply with the single word: hello');
    await page.click('#send-btn');

    // The 4B local model can be slow — generous ceilings.
    await page.locator('#messages .message.assistant').first().waitFor({ timeout: 90_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 90_000 });

    // No failed turn.
    expect(await page.locator('#messages .message.assistant').filter({ hasText: 'Turn failed' }).count()).toBe(0);

    // An assistant row carries non-empty content (SSE content_block_delta
    // streamed + the content[] array parsed) AND real usage from the Anthropic
    // message_start / message_delta events.
    const rows = await queryAll(page, `
      SELECT content, prompt_tokens, completion_tokens FROM messages
      WHERE session_id = 'default' AND role = 'assistant'
      ORDER BY id ASC
    `);
    expect(rows.length).toBeGreaterThan(0);
    const withContent = rows.filter((r) => typeof r[0] === 'string' && r[0].trim().length > 0);
    const withUsage = rows.filter((r) => r[1] > 0 && r[2] > 0);
    expect(withContent.length).toBeGreaterThan(0);
    expect(withUsage.length).toBeGreaterThan(0);
  });

  test('a JSON-in-content tool call round-trips (call → tool row → result)', async ({ page }) => {
    seedAnthropicProfile(page);
    await bootPage(page);

    await page.fill('#user-input', 'Run this exact SQL and tell me the result: SELECT 42 AS answer');
    await page.click('#send-btn');

    await page.locator('#messages .message.assistant').first().waitFor({ timeout: 90_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 90_000 });

    // No failed turn.
    expect(await page.locator('#messages .message.assistant').filter({ hasText: 'Turn failed' }).count()).toBe(0);

    // The model should have returned a JSON-in-content tool call that the
    // cascade parsed + executed → a `tool` row exists, and a later assistant
    // row reports the result. (A small local model MAY answer directly instead
    // of calling the tool — that is still valid Anthropic framing, so accept
    // either a tool round-trip OR a direct content answer.)
    const rows = await queryAll(page, `
      SELECT role, content FROM messages
      WHERE session_id = 'default' AND role IN ('assistant', 'tool')
      ORDER BY id ASC
    `);
    const toolRows = rows.filter((r) => r[0] === 'tool');
    const contentRows = rows.filter((r) => r[0] === 'assistant' && typeof r[1] === 'string' && r[1].trim().length > 0);
    // The turn produced a usable outcome via the Anthropic framing.
    expect(toolRows.length > 0 || contentRows.length > 0).toBe(true);
    // If the model DID call the tool, the round-trip must be complete: the
    // tool row is followed by an assistant row (the result answer).
    if (toolRows.length > 0) {
      const lastToolIdx = rows.findIndex((r, i) => r[0] === 'tool' && i >= rows.length - toolRows.length);
      expect(lastToolIdx).toBeGreaterThan(-1);
      expect(rows.slice(lastToolIdx + 1).some((r) => r[0] === 'assistant' && r[1] && r[1].trim().length > 0)).toBe(true);
    }
  });
});
