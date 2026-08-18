// Ticket 26.1 — shared helpers for the guardrails harness.
//
// Conventions enforced here (see tests/README.md):
//  - DB reads via these helpers are only legal when NO turn is in flight
//    (SQLite is single-threaded; a JSPI-suspended turn blocks every other
//    DB op on the connection).
//  - Waiting for turn completion is done on the DOM (bubbles), never by
//    polling the DB mid-turn.
//  - A "durable" fact is one that is in IndexedDB, not merely in the WASM
//    page cache. idbDump() is the durability-boundary check.

/** Wait for the app to finish booting (`window.__agent.db` is the live handle). */
export async function waitAgent(page, timeout = 20_000) {
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout });
}

/** Navigate to the app and wait for a full boot (input enabled). */
export async function bootPage(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitAgent(page);
  // The input is enabled a few lines after __agent is set; wait for it so
  // UI interactions don't race the tail of boot.
  await page.waitForSelector('#user-input:not([disabled])', { timeout: 15_000 });
}

/**
 * Handle native prompt()/alert() dialogs. Prompts are accepted with `name`
 * (the session-name prompt); everything else is dismissed.
 */
export function acceptPrompts(page, name) {
  page.once('dialog', (dialog) => {
    if (dialog.type() === 'prompt') dialog.accept(name);
    else dialog.dismiss();
  });
}

/**
 * Run a SQL query in the page against the live app DB.
 * ONLY when no turn is in flight (see conventions above).
 * Returns rows as arrays of values (wa-sqlite `sqlite3.row()` shape).
 */
export const queryAll = (page, sql, params = []) =>
  page.evaluate(
    async ([sql, params]) => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        while (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) rows.push(sqlite3.row(stmt));
      }
      return rows;
    },
    [sql, params],
  );

/** First value of the first row, or null. */
export const queryValue = (page, sql, params = []) =>
  queryAll(page, sql, params).then((rows) => (rows.length ? rows[0][0] : null));

/**
 * Dump the IDB-backed VFS state through a SECOND read-only connection (the
 * app's own connection is private to the VFS). This is the durability
 * boundary: a no-op commit (BUG-008) leaves the row only in the in-memory
 * page cache — same-connection reads see it, but no IDB block contains it.
 *
 * IDB layout (vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js):
 *   database 'idb', store 'blocks'   key [path, -offset, version]
 *   store 'metadata'                 key path → { name, fileSize, version, pendingVersion? }
 * Lower version = newer; a commit seals blocks at the (decremented)
 * metadata.version and deletes superseded versions.
 *
 * Returns { metadata, blocks: [{path, offset, version, size}], markerFound }.
 * `marker` (optional) is a unique string the test inserted; markerFound is
 * the block that contains it (the commit wrote the page) or null.
 */
export const idbDump = (page, marker = null) =>
  page.evaluate(
    async (marker) => {
      const idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('idb');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = idb.transaction(['blocks', 'metadata'], 'readonly');
          tx.onerror = () => reject(tx.error);
          const metaReq = tx.objectStore('metadata').get('/agent_brain.sqlite3');
          const blocks = [];
          let markerFound = null;
          const decoder = new TextDecoder();
          const curReq = tx.objectStore('blocks').openCursor();
          curReq.onsuccess = () => {
            const cur = curReq.result;
            if (cur) {
              const v = cur.value;
              blocks.push({
                path: v.path,
                offset: v.offset,
                version: v.version,
                size: v.data.byteLength,
              });
              if (marker && !markerFound && decoder.decode(v.data).includes(marker)) {
                markerFound = { path: v.path, offset: v.offset, version: v.version };
              }
              cur.continue();
            }
          };
          tx.oncomplete = () =>
            resolve({ metadata: metaReq.result ?? null, blocks, markerFound });
        });
      } finally {
        idb.close();
      }
    },
    marker,
  );

/**
 * Hard-kill the page mid-operation: CDP Target.closeTarget severs the
 * renderer without running unload handlers — the closest simulation of a
 * crash/reload landing mid-boot. Falls back to page.close().
 */
export async function hardKill(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { targetId } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Target.closeTarget', { targetId });
  } catch {
    await page.close();
  }
}

/** Seed the app's localStorage config before any page script runs. */
export async function seedConfig(page, cfg) {
  await page.addInitScript((c) => localStorage.setItem('sql-agent-config', JSON.stringify(c)), cfg);
}

/**
 * Create a session through the REAL UI path (#btn-new-session → prompt() →
 * createSession → setActiveSession → re-render) and return its id.
 */
export async function createSessionViaUi(page, name) {
  acceptPrompts(page, name);
  await page.click('#btn-new-session');
  const item = page.locator(`#session-list .session-item[data-session-name="${name}"]`);
  await item.waitFor({ timeout: 15_000 });
  await page.waitForSelector('#btn-new-session:not([disabled])', { timeout: 15_000 });
  const sessionId = await item.getAttribute('data-session-id');
  if (!sessionId) throw new Error(`session item for "${name}" has no data-session-id`);
  return sessionId;
}
