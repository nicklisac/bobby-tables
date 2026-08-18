import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    console.log(`[PAGE ${msg.type()}]:`, msg.text());
  });
  page.on('pageerror', (err) => {
    console.error('[PAGE ERROR]:', err);
  });

  console.log('=== Step 1: Boot initial page ===');
  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db));
  await page.waitForSelector('#user-input:not([disabled])', { timeout: 30000 });

  console.log('=== Step 2: Create session via UI ===');
  const name = `Probe Session ${Date.now()}`;
  page.on('dialog', (d) => {
    if (d.type() === 'prompt') d.accept(name);
    else d.dismiss();
  });
  await page.click('#btn-new-session');
  const item = page.locator(`#session-list .session-item[data-session-name="${name}"]`);
  await item.waitFor({ timeout: 30000 });
  const sessionId = await item.getAttribute('data-session-id');
  console.log('Created sessionId:', sessionId);

  console.log('=== Step 3: Seed message with cascade suppressed ===');
  await page.evaluate(async ([sid]) => {
    const { sqlite3, db } = window.__agent;
    const { setSuppressCascade } = await import('/src/schema.js');
    await setSuppressCascade(sqlite3, db, true);
    try {
      for await (const stmt of sqlite3.statements(
        db,
        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
      )) {
        sqlite3.bind_collection(stmt, [sid, 'user', 'T261 seed msg']);
        await sqlite3.step(stmt);
      }
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }
  }, [sessionId]);

  console.log('=== Step 4: Dump IDB state before reload ===');
  const preDump = await page.evaluate(async () => {
    const idb = await new Promise((resolve, reject) => {
      const req = indexedDB.open('idb');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = idb.transaction(['blocks', 'metadata'], 'readonly');
        const metaReq = tx.objectStore('metadata').get('/agent_brain.sqlite3');
        const blocks = [];
        const curReq = tx.objectStore('blocks').openCursor();
        curReq.onsuccess = () => {
          const cur = curReq.result;
          if (cur) {
            blocks.push({
              path: cur.value.path,
              offset: cur.value.offset,
              version: cur.value.version,
              size: cur.value.data.byteLength,
            });
            cur.continue();
          }
        };
        tx.oncomplete = () => resolve({ metadata: metaReq.result, blocks });
      });
    } finally {
      idb.close();
    }
  });
  console.log('Pre-reload IDB metadata:', JSON.stringify(preDump.metadata, null, 2));
  console.log('Pre-reload IDB blocks count:', preDump.blocks.length);
  console.log('Pre-reload IDB blocks:', JSON.stringify(preDump.blocks, null, 2));

  console.log('=== Step 5: Reload page ===');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  console.log('=== Step 6: Dump IDB state after reload ===');
  const postDump = await page.evaluate(async () => {
    const idb = await new Promise((resolve, reject) => {
      const req = indexedDB.open('idb');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = idb.transaction(['blocks', 'metadata'], 'readonly');
        const metaReq = tx.objectStore('metadata').get('/agent_brain.sqlite3');
        const blocks = [];
        const curReq = tx.objectStore('blocks').openCursor();
        curReq.onsuccess = () => {
          const cur = curReq.result;
          if (cur) {
            blocks.push({
              path: cur.value.path,
              offset: cur.value.offset,
              version: cur.value.version,
              size: cur.value.data.byteLength,
            });
            cur.continue();
          }
        };
        tx.oncomplete = () => resolve({ metadata: metaReq.result, blocks });
      });
    } finally {
      idb.close();
    }
  });
  console.log('Post-reload IDB metadata:', JSON.stringify(postDump.metadata, null, 2));
  console.log('Post-reload IDB blocks count:', postDump.blocks.length);
  console.log('Post-reload IDB blocks:', JSON.stringify(postDump.blocks, null, 2));
  const postReloadEvents = await page.evaluate(() => {
    return window.__agent.vfs.events || [];
  });
  console.log('Post-reload VFS events count:', postReloadEvents.length);
  console.log('Post-reload VFS events:', JSON.stringify(postReloadEvents, null, 2));

  try {
    const res = await page.evaluate(async (sid) => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, 'SELECT id FROM sessions WHERE id = ?')) {
        sqlite3.bind_collection(stmt, [sid]);
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    }, sessionId);
    console.log('Session query result:', res);
  } catch (e) {
    console.error('Session query error:', e.message);
  }

  try {
    const res = await page.evaluate(async (sid) => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, 'SELECT COUNT(*) FROM messages WHERE session_id = ?')) {
        sqlite3.bind_collection(stmt, [sid]);
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    }, sessionId);
    console.log('Message count query result:', res);
  } catch (e) {
    console.error('Message count query error:', e.message);
  }

  try {
    const integrity = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, 'PRAGMA integrity_check')) {
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    });
    console.log('PRAGMA integrity_check:', integrity);
  } catch (e) {
    console.error('PRAGMA integrity_check error:', e.message);
  }

  await browser.close();
}

main().catch(console.error);
