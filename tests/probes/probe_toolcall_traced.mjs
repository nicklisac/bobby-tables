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
    const body = llmCalls === 1
      ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_t261_1', type: 'function', function: { name: 'execute_sql', arguments: JSON.stringify({ query: `SELECT 1 AS ${TOOL_PROBE}` }) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }
      : { choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }], usage: { prompt_tokens: 12, completion_tokens: 7 } };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (/\[(ser|vfs|harness|probe)\]/.test(t) || msg.type() === 'error') {
      console.log(`[PAGE ${msg.type()}]:`, t);
    }
  });
  page.on('pageerror', (err) => console.error(`[PAGE ERROR]:`, err));

  await page.addInitScript((c) => {
    window.__T261_TRACE = true;
    localStorage.setItem('sql-agent-config', JSON.stringify(c));
  }, { provider: 'gemini', apiKey: 't261-fake-key', isConfigured: true, model: 'gemini-2.5-flash' });

  console.log('=== Booting page ===');
  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 60000 });
  await page.waitForSelector('#user-input:not([disabled])', { timeout: 30000 });
  console.log('Booted!');

  const name = `T261 Tool ${Date.now()}`;
  page.on('dialog', (d) => { if (d.type() === 'prompt') d.accept(name); else d.dismiss(); });
  await page.click('#btn-new-session');
  const item = page.locator(`#session-list .session-item[data-session-name="${name}"]`);
  await item.waitFor({ timeout: 30000 });
  const sessionId = await item.getAttribute('data-session-id');
  console.log('Created sessionId:', sessionId);

  console.log('=== Sending message (tool-call turn) ===');
  await page.fill('#user-input', MSG_TEXT);
  await page.click('#send-btn');
  await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 60000 });
  console.log('>>> TURN COMPLETE (assistant reply in DOM) <<<');
  // Match the real test: wait for the turn to fully commit (send button re-enabled)
  // before issuing the post-turn query.
  await page.waitForSelector('#send-btn:not([disabled])', { timeout: 20000 }).catch(() => console.log('>>> send-btn did NOT re-enable in 20s (turn stuck?)'));

  console.log('=== Post-turn SELECT with 20s Node watchdog ===');
  const selectPromise = page.evaluate(async ([sid]) => {
    const { sqlite3, db } = window.__agent;
    const rows = [];
    for await (const stmt of sqlite3.statements(db, 'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id')) {
      sqlite3.bind_collection(stmt, [sid]);
      while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
    }
    return { ok: true, n: rows.length };
  }, [sessionId]);
  const timeoutPromise = new Promise((r) => setTimeout(() => r({ ok: false, error: 'NODE_TIMEOUT_20s (SELECT hung)' }), 20000));
  const selectResult = await Promise.race([selectPromise, timeoutPromise]);
  console.log('>>> SELECT result:', JSON.stringify(selectResult));

  const vfsEvents = await page.evaluate(() => {
    const vfs = window.__agent && window.__agent.vfs;
    if (!vfs || !vfs.events) return '(no vfs.events)';
    return vfs.events.slice(-50);
  }).catch(e => '(vfs dump failed: ' + e + ')');
  console.log('=== VFS events (last 50) ===');
  console.log(JSON.stringify(vfsEvents, null, 1));

  await browser.close();
}

main().catch(console.error);
