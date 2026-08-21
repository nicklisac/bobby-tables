// T35c — fetch_url: preview + pointer to the full document.
//
// The tool result returns a PREVIEW (first max_chars chars, default 8000) to
// protect the context window, but the FULL page is stored in the document
// corpus. When truncated, the result carries doc_id + full_doc_hint telling
// the agent exactly how to pull the rest with plain SQL (no re-fetch). The
// chat renders the result pre-compacted (a collapsed <details>, expandable).
//
// The fake fetch host never resolves, so the dev fetch-proxy 5xx's and the
// UDF falls through to a direct browser fetch — which page.route intercepts
// (the same mechanism T28 relies on).
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig, queryAll, queryValue, waitAgent } from '../helpers.mjs';

const FAKE_REPLY = 't35c-ok-reply';
const HOST = 't35c-fetch.example';
const seedCfg = { provider: 'gemini', apiKey: 't35c-fake-key', isConfigured: true, model: 'gemini-2.5-flash' };

// Fake LLM: call #1 issues the given tool_calls, call #2 replies.
function routeToolTurn(page, toolCalls) {
  let calls = 0;
  page.route('**/chat/completions', (route) => {
    calls++;
    const body = calls === 1
      ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
      : { choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// Route the fetch target: a page whose <body> is exactly N 'x' chars (no
// whitespace) so the stripped text length is deterministic.
function routeLongPage(page, n) {
  page.route(`**://${HOST}/**`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<html><head><title>t35c page</title></head><body>${'x'.repeat(n)}</body></html>`,
    });
  });
}

// Drive one turn: the LLM issues the tool call, the (intercepted) fetch lands,
// the reply settles. Resolves once the turn-end re-render has completed.
async function runTurn(page, toolCalls) {
  routeToolTurn(page, toolCalls);
  await seedConfig(page, seedCfg);
  await bootPage(page);
  await page.fill('#user-input', 'fetch the page');
  await page.click('#send-btn');
  await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 30_000 });
  await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
}

// Read + parse the fetch_url tool result for a given tool_call_id.
async function fetchResult(page, toolCallId) {
  const rows = await queryAll(page, `SELECT content FROM messages WHERE role = 'tool' AND tool_call_id = ?`, [toolCallId]);
  expect(rows.length, 'a tool result row exists').toBe(1);
  return JSON.parse(rows[0][0]);
}

test.describe('T35c — fetch_url preview + full-document pointer', () => {
  test('truncated long page: preview capped, accurate flags, doc_id + hint, full doc in corpus', async ({ page }) => {
    test.setTimeout(60_000);
    const N = 20_000;
    routeLongPage(page, N);
    await runTurn(page, [tc('tc-f1', 'fetch_url', { url: `http://${HOST}/long` })]);

    const r = await fetchResult(page, 'tc-f1');
    expect(r.content.length, 'preview capped at the default 8000').toBe(8000);
    expect(r.truncated, 'flagged truncated').toBe(true);
    expect(r.total_chars, 'more text than the preview').toBeGreaterThan(8000);
    expect(typeof r.doc_id, 'doc_id is a number').toBe('number');
    expect(r.full_doc_hint, 'hint present when truncated').toContain(`document #${r.doc_id}`);
    expect(r.full_doc_hint, 'hint shows the exact next offset').toContain(`SUBSTR(content, ${8000 + 1},`);
    expect(r.full_doc_hint, 'hint names the doc id in the WHERE clause').toContain(`WHERE id = ${r.doc_id}`);

    // The corpus stored the FULL page — exactly what total_chars reports (not
    // the 8000-char preview). This is the core of T35c.
    const storedLen = await queryValue(page, `SELECT LENGTH(content) FROM documents WHERE id = ?`, [r.doc_id]);
    expect(storedLen, 'corpus holds the whole page (matches total_chars)').toBe(r.total_chars);
  });

  test('short page: not truncated, no hint, full content returned', async ({ page }) => {
    test.setTimeout(60_000);
    const N = 120;
    routeLongPage(page, N);
    await runTurn(page, [tc('tc-f2', 'fetch_url', { url: `http://${HOST}/short` })]);

    const r = await fetchResult(page, 'tc-f2');
    expect(r.truncated, 'not truncated').toBe(false);
    expect(r.content.length, 'whole page returned (no truncation)').toBe(r.total_chars);
    expect(r.full_doc_hint, 'no hint when not truncated').toBeUndefined();
    expect(typeof r.doc_id, 'doc_id still set (page was ingested)').toBe('number');
  });

  test('max_chars param: smaller preview, hint offset follows the cap', async ({ page }) => {
    test.setTimeout(60_000);
    const N = 20_000;
    routeLongPage(page, N);
    await runTurn(page, [tc('tc-f3', 'fetch_url', { url: `http://${HOST}/long2`, max_chars: 3000 })]);

    const r = await fetchResult(page, 'tc-f3');
    expect(r.content.length, 'preview capped at the requested 3000').toBe(3000);
    expect(r.truncated).toBe(true);
    expect(r.total_chars).toBeGreaterThan(3000);
    expect(r.full_doc_hint, 'offset follows the requested cap').toContain(`SUBSTR(content, ${3000 + 1},`);
  });

  test('UI: fetch result is pre-compacted (collapsed <details>) and expandable', async ({ page }) => {
    test.setTimeout(60_000);
    const N = 20_000;
    routeLongPage(page, N);
    await runTurn(page, [tc('tc-f4', 'fetch_url', { url: `http://${HOST}/long3` })]);

    const el = page.locator('#messages .fetch-url-result');
    await el.first().waitFor({ timeout: 20_000 });
    expect(await el.first().evaluate((d) => d.open), 'collapsed by default').toBe(false);

    const summaryText = await el.first().locator('summary').innerText();
    expect(summaryText, 'summary shows the char count').toMatch(/[\d,]+ chars/);
    expect(summaryText, 'summary shows the full-doc badge').toContain('full doc #');

    // Click the chevron (a non-interactive part of the summary) — a default
    // center-click would land on the URL <a> link and try to navigate.
    await el.first().locator('.fetch-url-chevron').click();
    expect(await el.first().evaluate((d) => d.open), 'expanded on click').toBe(true);
    expect(await el.first().locator('.fetch-url-body').count(), 'preview body revealed').toBe(1);
  });

  test('existing brain: a stale fetch_url description is refreshed on re-boot', async ({ page }) => {
    test.setTimeout(60_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);

    // Fresh brain: the seed installed the new description.
    const fresh = await queryValue(page, `SELECT schema FROM tools WHERE name = 'fetch_url'`);
    expect(fresh, 'fresh brain has the new description').toContain('full_doc_hint');

    // Simulate a returning visitor whose brain still carries the OLD description.
    await queryAll(page, `UPDATE tools SET schema = ? WHERE name = 'fetch_url'`,
      ['{"type":"function","function":{"name":"fetch_url","description":"Fetch the content of a web URL. Returns the page text content."}}']);
    const stale = await queryValue(page, `SELECT schema FROM tools WHERE name = 'fetch_url'`);
    expect(stale, 'set to the old description for the re-boot').not.toContain('full_doc_hint');

    // Re-boot (the brain persists in IndexedDB) → migrateToolsTable refreshes it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    const refreshed = await queryValue(page, `SELECT schema FROM tools WHERE name = 'fetch_url'`);
    expect(refreshed, 're-boot refreshes the stale description').toContain('full_doc_hint');
  });
});
