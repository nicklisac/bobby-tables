import { chromium } from 'playwright';

async function hardKill(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { targetId } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Target.closeTarget', { targetId });
  } catch (e) {
    console.log('hardKill fallback:', e.message);
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });

  const context = await browser.newContext();

  function attachLog(page, label) {
    page.on('console', (msg) => console.log(`[${label} ${msg.type()}]:`, msg.text()));
    page.on('pageerror', (err) => console.error(`[${label} ERROR]:`, err));
  }

  console.log('=== Step 1: Initial boot and seed ===');
  let page = await context.newPage();
  attachLog(page, 'p0');
  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready));
  await page.waitForSelector('#user-input:not([disabled])', { timeout: 30000 });

  const name = `Kill Probe ${Date.now()}`;
  page.on('dialog', (d) => {
    if (d.type() === 'prompt') d.accept(name);
    else d.dismiss();
  });
  await page.click('#btn-new-session');
  const item = page.locator(`#session-list .session-item[data-session-name="${name}"]`);
  await item.waitFor({ timeout: 30000 });
  const sessionId = await item.getAttribute('data-session-id');
  console.log('Created sessionId:', sessionId);

  console.log('Starting page.evaluate for seed data...');
  await page.evaluate(async ([sid]) => {
    console.log('[probe] eval step 1');
    const { sqlite3, db } = window.__agent;
    console.log('[probe] eval step 2', !!sqlite3, !!db);
    const { setSuppressCascade } = await import('/src/schema.js');
    console.log('[probe] eval step 3, calling setSuppressCascade...');
    await setSuppressCascade(sqlite3, db, true);
    console.log('[probe] eval step 4, starting statements...');
    try {
      for await (const stmt of sqlite3.statements(
        db,
        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
      )) {
        console.log('[probe] eval step 5, binding and stepping...');
        sqlite3.bind_collection(stmt, [sid, 'user', 'T261 seed msg']);
        const rc = await sqlite3.step(stmt);
        console.log('[probe] eval step 6, stepped, rc =', rc);
      }
      console.log('[probe] eval step 7, statements complete');
    } finally {
      console.log('[probe] eval step 8, resetting suppressCascade');
      await setSuppressCascade(sqlite3, db, false);
      console.log('[probe] eval step 9, suppressCascade reset');
    }
  }, [sessionId]);
  console.log('Finished page.evaluate for seed data!');

  await page.close();

  for (const delay of [300, 1500, 2500]) {
    console.log(`\n=== Testing kill @ ${delay}ms ===`);
    page = await context.newPage();
    attachLog(page, `kill-${delay}`);
    await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(delay);
    console.log(`Killing page at ${delay}ms...`);
    await hardKill(page);

    console.log(`Booting recovery page after kill @ ${delay}ms...`);
    page = await context.newPage();
    attachLog(page, `recover-${delay}`);
    await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });

    console.log('Waiting for window.__agent...');
    await page.waitForFunction(() => !!(window.__agent && window.__agent.db), null, { timeout: 15000 });
    console.log('window.__agent exists! Waiting for window.__agent.ready...');
    try {
      await page.waitForFunction(() => !!window.__agent.ready, null, { timeout: 15000 });
      console.log('window.__agent.ready is TRUE!');
    } catch (e) {
      console.error('TIMED OUT waiting for window.__agent.ready!');
      const agentState = await page.evaluate(() => {
        return {
          hasAgent: !!window.__agent,
          hasDb: !!window.__agent?.db,
          ready: window.__agent?.ready,
          statusText: document.getElementById('status-bar')?.textContent,
        };
      });
      console.error('Agent state in page:', agentState);
      break;
    }

    const integrity = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, 'PRAGMA integrity_check')) {
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    });
    console.log(`Integrity after kill @ ${delay}ms:`, integrity);
  }

  await browser.close();
}

main().catch(console.error);
