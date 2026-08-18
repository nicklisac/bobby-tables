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
      console.log('exec:', sql);
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        const rc = await sqlite3.step(stmt);
        console.log('step rc:', rc);
      }
      console.log('exec done:', sql);
    };

    console.log('--- starting savepoint ---');
    await exec('SAVEPOINT test_sp');
    console.log('--- inserting ---');
    await exec('CREATE TABLE IF NOT EXISTS t_sp (id INT, val TEXT)');
    await exec('INSERT INTO t_sp VALUES (1, ?)', ['hello']);
    console.log('--- releasing ---');
    await exec('RELEASE test_sp');
    console.log('--- query after release: entering statements generator ---');
    const gen = sqlite3.statements(db, 'SELECT * FROM t_sp');
    console.log('calling gen.next()...');
    const iter = await gen.next();
    console.log('gen.next returned:', iter);
    if (!iter.done) {
      const stmt = iter.value;
      console.log('got stmt:', stmt);
      const stepRc = await sqlite3.step(stmt);
      console.log('stepRc:', stepRc);
      if (stepRc === 100) console.log('row:', sqlite3.row(stmt));
      await gen.return();
    }
    console.log('--- ALL DONE ---');
    return 'OK';
  });

  console.log('Result:', result);
  await browser.close();
}

main().catch(console.error);
