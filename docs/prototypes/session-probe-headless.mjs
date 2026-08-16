import { chromium } from 'playwright';

async function main() {
  const url = 'http://localhost:5174';
  console.log(`Connecting to dev server at ${url}...`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--js-flags=--experimental-wasm-jspi'],
    });
  } catch {
    browser = await chromium.launch({
      headless: true,
      channel: 'msedge',
      args: ['--js-flags=--experimental-wasm-jspi'],
    });
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => console.log(`[Browser Console ${msg.type()}]:`, msg.text()));
  page.on('pageerror', err => console.error('[Browser Page Error]:', err));

  await page.goto(url);
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db), { timeout: 30000 });
  console.log('✓ Agent initialized!');

  const result = await page.evaluate(async () => {
    const { sqlite3, db } = window.__agent;
    const { createSession, renameSession, deleteSession, listSessions, queryAll } = await import('/src/schema.js');

    // 1. Initial sessions
    const initialSessions = await listSessions(sqlite3, db);

    // 2. Create Session 'Test Beta'
    const betaId = await createSession(sqlite3, db, 'Test Beta');
    const afterCreate = await listSessions(sqlite3, db);
    const betaSession = afterCreate.find(s => s.id === betaId);

    // 3. Rename Session 'Test Beta' -> 'Renamed Beta'
    await renameSession(sqlite3, db, betaId, 'Renamed Beta');
    const afterRename = await listSessions(sqlite3, db);
    const renamedSession = afterRename.find(s => s.id === betaId);

    // 4. Insert dummy message into beta session
    await queryAll(sqlite3, db, `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'Hello Beta')`, [betaId]);

    // 5. Delete Session 'Renamed Beta'
    await deleteSession(sqlite3, db, betaId);
    const afterDelete = await listSessions(sqlite3, db);
    const deletedInList = afterDelete.find(s => s.id === betaId);

    // 6. Check messages in deleted session
    const msgRows = await queryAll(sqlite3, db, `SELECT COUNT(*) FROM messages WHERE session_id = ?`, [betaId]);
    const msgCount = msgRows.length ? msgRows[0][0] : 0;

    return {
      initialCount: initialSessions.length,
      betaCreated: !!betaSession && betaSession.name === 'Test Beta',
      betaRenamed: !!renamedSession && renamedSession.name === 'Renamed Beta',
      betaDeletedFromSessions: !deletedInList,
      messagesCleanedUp: msgCount === 0,
    };
  });

  console.log('SESSION PROBE RESULT:', JSON.stringify(result, null, 2));
  await browser.close();

  const allOk = result.betaCreated && result.betaRenamed && result.betaDeletedFromSessions && result.messagesCleanedUp;
  if (allOk) {
    console.log('✅ Session creation, renaming, and deletion PASSED!');
    process.exit(0);
  } else {
    console.error('❌ Session probe FAILED');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
