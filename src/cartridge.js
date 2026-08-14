/**
 * CARTRIDGE — Import/Export .sqlite3 agent brains.
 *
 * Uses VACUUM INTO + sqlite3_serialize for export.
 * Uses File System Access API with fallback for file I/O.
 */

/**
 * Export the current database as a .sqlite3 file download.
 * @param {object} sqlite3 - wa-sqlite SQLiteAPI instance
 * @param {number} db - Database handle pointer
 * @param {string} filename - Suggested download filename
 */
export async function exportCartridge(sqlite3, db, filename = 'bobby-brain.sqlite3') {
  // Step 1: VACUUM INTO a temporary in-memory database
  const tempFile = `file:export_${Date.now()}?vfs=memory`;
  await sqlite3.exec(db, `VACUUM INTO '${tempFile}';`);

  // Step 2: Open the temp DB and serialize to bytes
  let pTempDb = 0;
  try {
    const pTempDbOut = sqlite3.alloc(4);
    await sqlite3.open_v2(tempFile, pTempDbOut, 0x00000006 /* READWRITE | URI */, null);
    pTempDb = sqlite3.get_value(pTempDbOut, 0, 'i32');
    sqlite3.free(pTempDbOut);

    // Try sqlite3_serialize (may not be available in all builds)
    let bytes;
    try {
      // Some wa-sqlite builds expose serialize directly
      bytes = await sqlite3.serialize(pTempDb, 'main');
    } catch {
      // Fallback: read the memory VFS file directly
      // Use backup API to copy to a known-memory file, then read
      throw new Error('sqlite3_serialize not available in this build. Use SQL dump instead.');
    }

    // Step 3: Trigger download
    await saveFile(bytes, filename);
    return { success: true, bytes: bytes.length };
  } finally {
    if (pTempDb) await sqlite3.close(pTempDb);
  }
}

/**
 * Import a .sqlite3 cartridge file, replacing the current database.
 * @param {object} sqlite3 - wa-sqlite SQLiteAPI instance
 * @param {string} dbName - Name of the persistent database
 * @param {string} vfsName - Name of the VFS to use
 * @returns {Promise<number>} New database handle
 */
export async function importCartridge(sqlite3, dbName, vfsName) {
  // Step 1: Prompt user to select a .sqlite3 file
  const fileBytes = await pickFile();
  if (!fileBytes) throw new Error('File selection cancelled.');

  // Step 2: Clear IndexedDB storage for this database
  // IDBBatchAtomicVFS stores data under the dbName key
  await clearIndexedDB(dbName);

  // Step 3: Open temp memory DB and load imported bytes
  const tempFile = `file:import_${Date.now()}?vfs=memory`;
  let pTempDb = 0;
  let pNewDb = 0;

  try {
    const pTempDbOut = sqlite3.alloc(4);
    await sqlite3.open_v2(tempFile, pTempDbOut, 0x00000006 | 0x00000004 /* READWRITE | CREATE | URI */, null);
    pTempDb = sqlite3.get_value(pTempDbOut, 0, 'i32');
    sqlite3.free(pTempDbOut);

    // Deserialize bytes into temp DB
    try {
      await sqlite3.deserialize(pTempDb, 'main', fileBytes);
    } catch {
      throw new Error('sqlite3_deserialize not available. Cannot import binary cartridge.');
    }

    // Step 4: Open fresh persistent DB
    const pNewDbOut = sqlite3.alloc(4);
    await sqlite3.open_v2(dbName, pNewDbOut, 0x00000006 | 0x00000004 /* READWRITE | CREATE */, vfsName);
    pNewDb = sqlite3.get_value(pNewDbOut, 0, 'i32');
    sqlite3.free(pNewDbOut);

    // Step 5: Backup from temp DB to persistent DB
    const pBackup = await sqlite3.backup_init(pNewDb, 'main', pTempDb, 'main');
    if (!pBackup) {
      throw new Error(`backup_init failed: ${sqlite3.errmsg(pNewDb)}`);
    }

    await sqlite3.backup_step(pBackup, -1); // Copy all pages at once
    await sqlite3.backup_finish(pBackup);

    return pNewDb;
  } finally {
    if (pTempDb) await sqlite3.close(pTempDb);
  }
}

/**
 * Alternative export: generate a SQL dump instead of binary.
 * Works with any wa-sqlite build (no serialize needed).
 */
export async function exportSqlDump(sqlite3, db, filename = 'bobby-brain.sql') {
  const lines = [];
  await sqlite3.exec(db, `.dump`, null, {
    resultText: (text) => lines.push(text),
  });

  const sql = lines.join('\n');
  const blob = new Blob([sql], { type: 'text/sql' });

  // Download via anchor tag
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { success: true, bytes: sql.length };
}

// ── File I/O Helpers ────────────────────────────────────────────────

async function saveFile(data, suggestedName) {
  // Try File System Access API first
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'SQLite 3 Database',
          accept: { 'application/x-sqlite3': ['.sqlite3', '.db', '.sqlite'] },
        }],
      });
      const writable = await handle.createWritable();
      if (data instanceof Uint8Array) {
        await writable.write(data);
      } else {
        await writable.write(data);
      }
      await writable.close();
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[cartridge] showSaveFilePicker failed, falling back', err);
    }
  }

  // Fallback: blob download
  const blob = new Blob([data], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function pickFile() {
  // Try File System Access API first
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'SQLite 3 Database',
          accept: { 'application/x-sqlite3': ['.sqlite3', '.db', '.sqlite'] },
        }],
        multiple: false,
      });
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (err.name === 'AbortError') return null;
      console.warn('[cartridge] showOpenFilePicker failed, falling back', err);
    }
  }

  // Fallback: hidden file input
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sqlite3,.db,.sqlite,application/x-sqlite3';
    input.onchange = async () => {
      if (input.files?.[0]) {
        const buf = await input.files[0].arrayBuffer();
        resolve(new Uint8Array(buf));
      } else {
        resolve(null);
      }
    };
    input.click();
  });
}

async function clearIndexedDB(dbName) {
  // IDBBatchAtomicVFS uses the dbName as the IndexedDB database name
  // We need to delete it to avoid stale page blocks
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => {
      // If it doesn't exist, that's fine
      if (req.error?.name === 'NotFoundError') {
        resolve();
      } else {
        reject(req.error);
      }
    };
    req.onblocked = () => resolve(); // Proceed once existing connections drop
  });
}
