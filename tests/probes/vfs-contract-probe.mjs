// Ticket 26.1 — VFS write-pattern contract probe.
//
// Runs in the page against the LIVE app DB (real IDBBatchAtomicVFS on
// IndexedDB). For each canonical write pattern it inserts a unique marker
// row, then dumps the IDB blocks through a second read-only connection and
// asserts the marker actually reached IDB at the committed metadata version
// — i.e., the commit wrote the page.
//
// This is the data-boundary check from the BUG-008 post-mortem ("does the
// row reach IDB?"). A no-op commit (the pager never transitioning to a
// write transaction) leaves the row only in the in-memory page cache:
// same-connection reads see it, but no IDB block contains it.
//
// IDB layout (vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js):
//   database 'idb'; store 'blocks' key [path, -offset, version]
//   store 'metadata' key path → { name, fileSize, version, pendingVersion? }
// Lower version = newer. A write transaction stamps its pages at
// version-1; the commit (FCNTL_SYNC seal) puts the decremented metadata and
// deletes superseded versions. A crash mid-transaction leaves
// metadata.pendingVersion set, which the next SHARED lock cleans up.
//
// Run standalone from the preview browser:
//   import('/tests/probes/vfs-contract-probe.mjs?t=' + Date.now())
//     .then(m => m.runVfsContractProbe())
// or via the harness: npm test (tests/specs/vfs-contract.spec.mjs)

const SQLITE_ROW = 100;

async function idbDump(marker) {
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
}

export async function runVfsContractProbe() {
  const { sqlite3, db } = window.__agent;

  const exec = async (sql, params = []) => {
    if (params.length === 0) {
      await sqlite3.exec(db, sql);
      return;
    }
    for await (const stmt of sqlite3.statements(db, sql)) {
      sqlite3.bind_collection(stmt, params);
      while (await sqlite3.step(stmt) === SQLITE_ROW) {}
    }
  };
  const q = async (sql) => {
    const rows = [];
    for await (const stmt of sqlite3.statements(db, sql)) {
      while (await sqlite3.step(stmt) === SQLITE_ROW) rows.push(sqlite3.row(stmt));
    }
    return rows;
  };

  const R = { patterns: {}, integrity: null, ok: false };

  // Scratch table, created after boot's capture-trigger sweep → no capture
  // triggers, no cascade involvement.
  await exec('CREATE TABLE IF NOT EXISTS t261_probe (id INTEGER PRIMARY KEY, payload TEXT)');

  const rand = Math.random().toString(36).slice(2, 10);
  const patterns = [
    {
      // (a) The pattern the app is allowed to use for single statements.
      name: 'autocommit_insert',
      run: (m) => exec('INSERT INTO t261_probe (payload) VALUES (?)', [m]),
    },
    {
      // (b) The BUG-008 trigger pattern: a single INSERT wrapped in a
      // savepoint. If the pager skips the write-transaction transition, the
      // RELEASE commits zero dirty pages and the marker never reaches IDB.
      name: 'savepoint_insert_release',
      run: async (m) => {
        await exec('SAVEPOINT t261_sp');
        await exec('INSERT INTO t261_probe (payload) VALUES (?)', [m]);
        await exec('RELEASE t261_sp');
      },
    },
    {
      // (c) Multi-statement atomic op — the rule-mandated pattern
      // (BEGIN IMMEDIATE forces the write-transaction transition up front).
      name: 'begin_immediate_commit',
      run: async (m) => {
        console.log('[probe] begin_immediate_commit: running BEGIN IMMEDIATE...');
        await exec('BEGIN IMMEDIATE');
        console.log('[probe] begin_immediate_commit: running INSERT...');
        await exec('INSERT INTO t261_probe (payload) VALUES (?)', [m]);
        console.log('[probe] begin_immediate_commit: running COMMIT...');
        await exec('COMMIT');
        console.log('[probe] begin_immediate_commit: COMMIT finished!');
      },
    },
    {
      // (d) Deferred multi-statement txn (two INSERTs, one commit).
      name: 'multi_statement_txn',
      run: async (m) => {
        await exec('BEGIN');
        await exec('INSERT INTO t261_probe (payload) VALUES (?)', [m + '_a']);
        await exec('INSERT INTO t261_probe (payload) VALUES (?)', [m + '_b']);
        await exec('COMMIT');
      },
    },
    {
      // (e) DDL inside a txn (new table + row, one commit).
      name: 'ddl_in_txn',
      run: async (m) => {
        const t = `t261_ddl_${rand}`;
        await exec('BEGIN IMMEDIATE');
        await exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, payload TEXT)`);
        await exec(`INSERT INTO ${t} (payload) VALUES (?)`, [m]);
        await exec('COMMIT');
      },
    },
  ];

  for (const p of patterns) {
    const marker = `t261_${p.name}_${rand}`;
    console.log(`[probe] Starting pattern: ${p.name}`);

    // Baseline: the marker must not exist in IDB before the write.
    const before = await idbDump(marker);
    if (before.markerFound) {
      console.log(`[probe] Pattern ${p.name} fatal: marker present before write`);
      R.patterns[p.name] = { fatal: 'marker present before write (test bug)' };
      continue;
    }

    console.log(`[probe] Running pattern ${p.name}...`);
    await p.run(marker);
    await new Promise((r) => setTimeout(r, 10));
    console.log(`[probe] Pattern ${p.name} finished run, draining...`);

    // Drain the VFS's IDB chain: a page read through the app connection
    // awaits the serialized chain, so by the time it returns the write's
    // IDB transaction has committed.
    await q('SELECT COUNT(*) FROM t261_probe');
    console.log(`[probe] Pattern ${p.name} drained, dumping IDB...`);

    const after = await idbDump(marker);
    const meta = after.metadata;
    console.log(`[probe] Pattern ${p.name} dumped IDB: inIdb=${after.markerFound !== null}`);
    R.patterns[p.name] = {
      marker,
      inIdb: after.markerFound !== null,
      atCommittedVersion:
        !!after.markerFound && !!meta && after.markerFound.version === meta.version,
      noPendingVersion: !!meta && !meta.pendingVersion,
      block: after.markerFound,
      metaVersion: meta ? meta.version : null,
    };
  }

  R.integrity = (await q('PRAGMA integrity_check'))[0]?.[0] ?? null;
  R.ok =
    R.integrity === 'ok' &&
    Object.values(R.patterns).every(
      (r) => r.inIdb && r.atCommittedVersion && r.noPendingVersion,
    );
  return R;
}
