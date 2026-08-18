import { chromium } from 'playwright';

const FAKE_REPLY = 'fake LLM reply for T26.1 test';
const MSG_TEXT = 'hello from persistence test';
const TOOL_PROBE = 't261_tool_probe';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });

  const context = await browser.newContext();

  let llmCalls = 0;
  await context.route('**/chat/completions', (route) => {
    llmCalls++;
    console.log(`[route] LLM call #${llmCalls}`);
    const body = llmCalls === 1
      ? {
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_t261_1',
                type: 'function',
                function: { name: 'execute_sql', arguments: { query: `SELECT 1 AS ${TOOL_PROBE}` } },
              }],
            },
          }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }
      : {
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[PAGE ${msg.type()}]:`, msg.text()));
  page.on('pageerror', (err) => console.error(`[PAGE ERROR]:`, err));

  await page.addInitScript((c) => {
    localStorage.setItem('sql-agent-config', JSON.stringify(c));
  }, {
    provider: 'gemini',
    apiKey: 't261-fake-key',
    isConfigured: true,
    model: 'gemini-2.5-flash',
  });

  console.log('=== Booting page ===');
  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready));
  await page.waitForSelector('#user-input:not([disabled])', { timeout: 30000 });
  console.log('Booted!');

  const name = `T261 Tool ${Date.now()}`;
  page.on('dialog', (d) => {
    if (d.type() === 'prompt') d.accept(name);
    else d.dismiss();
  });
  await page.click('#btn-new-session');
  const item = page.locator(`#session-list .session-item[data-session-name="${name}"]`);
  await item.waitFor({ timeout: 30000 });
  const sessionId = await item.getAttribute('data-session-id');
  console.log('Created sessionId:', sessionId);

  console.log('=== Sending message ===');
  await page.fill('#user-input', MSG_TEXT);
  await page.click('#send-btn');

  console.log('Waiting for assistant message on DOM...');
  await page
    .locator('#messages .message.assistant')
    .filter({ hasText: FAKE_REPLY })
    .first()
    .waitFor({ timeout: 15000 });
  console.log('Assistant message reached DOM!');

  const msgs = await page.evaluate(async ([sid]) => {
    const { sqlite3, db } = window.__agent;
    const rows = [];
    for await (const stmt of sqlite3.statements(db, 'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id')) {
      sqlite3.bind_collection(stmt, [sid]);
      while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
    }
    return rows;
  }, [sessionId]);
  console.log('Messages before reload:', msgs);

  console.log('=== Reloading page ===');
  await page.reload({ waitUntil: 'domcontentloaded' });
  console.log('Waiting for window.__agent.ready after reload...');
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready));
  console.log('Ready after reload!');

  const msgs2 = await page.evaluate(async ([sid]) => {
    const { sqlite3, db } = window.__agent;
    const rows = [];
    for await (const stmt of sqlite3.statements(db, 'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id')) {
      sqlite3.bind_collection(stmt, [sid]);
      while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
    }
    return rows;
  }, [sessionId]);
  console.log('Messages after reload:', msgs2);

  const integrity = await page.evaluate(async () => {
    const { sqlite3, db } = window.__agent;
    const rows = [];
    for await (const stmt of sqlite3.statements(db, 'PRAGMA integrity_check')) {
      while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
    }
    return rows;
  });
  console.log('Integrity after reload:', integrity);

  await browser.close();
}

main().catch(console.error);
