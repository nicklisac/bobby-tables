import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[PAGE ${msg.type()}]:`, msg.text()));
  page.on('pageerror', (err) => console.error(`[PAGE ERROR]:`, err));

  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready));

  const result = await page.evaluate(async () => {
    const { sqlite3, db } = window.__agent;
    const exec = async (sql, params = []) => {
      if (params.length === 0) {
        await sqlite3.exec(db, sql);
        return;
      }
      for await (const stmt of sqlite3.statements(db, sql)) {
        sqlite3.bind_collection(stmt, params);
        while (await sqlite3.step(stmt) === 100) {}
      }
    };
    const q = async (sql) => {
      const rows = [];
      await sqlite3.exec(db, sql, (row) => rows.push(row));
      return rows;
    };

    console.log('1. create table');
    await exec('CREATE TABLE IF NOT EXISTS t_probe (id INTEGER PRIMARY KEY, payload TEXT)');
    console.log('2. savepoint');
    await exec('SAVEPOINT t_sp');
    console.log('3. insert');
    await exec('INSERT INTO t_probe (payload) VALUES (?)', ['hello_savepoint']);
    console.log('4. release');
    await exec('RELEASE t_sp');
    await new Promise(r => setTimeout(r, 10));
    console.log('5. select count');
    const rows = await q('SELECT COUNT(*) FROM t_probe');
    console.log('6. rows:', rows);
    return rows;
  });

  console.log('Result from probe:', result);
  await browser.close();
}

main().catch(console.error);
