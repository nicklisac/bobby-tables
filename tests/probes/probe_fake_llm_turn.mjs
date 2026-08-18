import { chromium } from 'playwright';

const FAKE_REPLY = 'fake LLM reply for T26.1 test';
const MSG_TEXT = 'hello from persistence test';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });

  const context = await browser.newContext();

  await context.route('**/chat/completions', (route) => {
    console.log('[route] Intercepted completions request to:', route.request().url());
    console.log('[route] Request method:', route.request().method());
    console.log('[route] Request postData:', route.request().postData());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }),
    });
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

  const name = `T261 Turn ${Date.now()}`;
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

  console.log('Waiting for assistant message locator on DOM...');
  try {
    await page
      .locator('#messages .message.assistant')
      .filter({ hasText: FAKE_REPLY })
      .first()
      .waitFor({ timeout: 15000 });
    console.log('SUCCESS! Assistant message appeared in DOM!');

    console.log('=== Checking DB after turn ===');
    const msgs = await page.evaluate(async ([sid]) => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, 'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id')) {
        sqlite3.bind_collection(stmt, [sid]);
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    }, [sessionId]);
    console.log('Messages in DB after turn:', msgs);

    console.log('=== Checking IDB after turn ===');
    const idbResult = await page.evaluate(async (marker) => {
      const idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('idb');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = idb.transaction(['blocks', 'metadata'], 'readonly');
          let markerFound = null;
          const decoder = new TextDecoder();
          const curReq = tx.objectStore('blocks').openCursor();
          curReq.onsuccess = () => {
            const cur = curReq.result;
            if (cur) {
              const v = cur.value;
              if (marker && !markerFound && decoder.decode(v.data).includes(marker)) {
                markerFound = { path: v.path, offset: v.offset, version: v.version };
              }
              cur.continue();
            }
          };
          tx.oncomplete = () => resolve({ markerFound });
        });
      } finally {
        idb.close();
      }
    }, MSG_TEXT);
    console.log('IDB marker found:', idbResult);

    console.log('=== Reloading page ===');
    await page.reload({ waitUntil: 'domcontentloaded' });
    console.log('Waiting for window.__agent.ready after reload...');
    await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready));
    console.log('Agent ready after reload!');

    console.log('=== Checking DB after reload ===');
    const msgs2 = await page.evaluate(async ([sid]) => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, 'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id')) {
        sqlite3.bind_collection(stmt, [sid]);
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    }, [sessionId]);
    console.log('Messages in DB after reload:', msgs2);

    const integrity = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, 'PRAGMA integrity_check')) {
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    });
    console.log('PRAGMA integrity_check after reload:', integrity);
  } catch (e) {
    console.error('Probe error:', e);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
