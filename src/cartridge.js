/**
 * CARTRIDGE — Import/Export .sqlite3 agent brains.
 *
 * Export: live DB ──backup API──▶ :memory: DB ──sqlite3_serialize──▶ bytes
 * Import: file bytes ──sqlite3_deserialize──▶ :memory: DB ──backup API──▶ live DB
 *
 * Why this shape:
 *  - The backup API is the sanctioned way to snapshot a live database — it is
 *    safe with active prepared statements and transactions, unlike VACUUM INTO
 *    (which also required a `memory` VFS that is not registered in this app).
 *  - `:memory:` uses SQLite's built-in memdb VFS, which is always available —
 *    no URI filenames, no extra VFS registration.
 *  - sqlite3_serialize / sqlite3_deserialize / sqlite3_backup_* are exported by
 *    the WASM binary but NOT by the JS API wrapper (sqlite-api.js), so we call
 *    the raw exports (module._sqlite3_*) directly.
 *
 *    This only works because those exports are JSPI-suspendable — i.e. present
 *    in the `exportPattern` patch to vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs.
 *    See vendor/wa-sqlite-jspi/README.md; reapply that patch after any
 *    rebuild/re-vendor of the runtime, or these calls throw SuspendError.
 *
 * JSPI return-value note: in this build a suspendable function returns a
 * Promise only when it actually suspends; otherwise it returns the value
 * eagerly. `await` normalizes both cases — which is why we use raw exports
 * instead of Module.cwrap(..., { async: true }) (whose ccall crashes on
 * eager values: `ret.then is not a function`).
 *
 * String-arg note: C strings are allocated on the wasm HEAP (sqlite3_malloc)
 * and freed only AFTER the awaited call resolves — freeing on the stack or
 * before resolution would corrupt args of a still-suspended call.
 *
 * i64 ABI note: this build passes i64 arguments as two i32s, low half first
 * (verified against the sqlite3_bind_int64 wrapper).
 */

const SQLITE_OK = 0;
const SQLITE_DONE = 101;
const SQLITE_ROW = 100;
const SQLITE_SERIALIZE_NORMAL = 0;
const SQLITE_DESERIALIZE_DEFAULT = 0;
const OPEN_READWRITE = 0x00000002;
const OPEN_CREATE = 0x00000004;

// ── Raw-ABI helpers ─────────────────────────────────────────────────

/** Allocate a NUL-terminated UTF-8 C string on the wasm heap. */
function toCString(module, str) {
  const utf8 = new TextEncoder().encode(str);
  const ptr = module._sqlite3_malloc(utf8.length + 1);
  if (!ptr) throw new Error('sqlite3_malloc failed');
  module.HEAPU8.set(utf8, ptr);
  module.HEAPU8[ptr + utf8.length] = 0;
  return ptr;
}

function freeCString(module, ptr) {
  if (ptr) module._sqlite3_free(ptr);
}

/** Read an i64 from a wasm pointer (lo32 | hi32 << 32). */
function readI64(module, ptr) {
  const lo = module.HEAPU32[ptr >> 2];
  const hi = module.HEAPU32[(ptr + 4) >> 2];
  return Number(BigInt(hi) * 4294967296n + BigInt(lo));
}

function errname(module, rc) {
  try {
    const ptr = module._sqlite3_errstr(rc);
    return ptr ? module.UTF8ToString(ptr) : `rc=${rc}`;
  } catch {
    return `rc=${rc}`;
  }
}

/** Open a fresh in-memory database (built-in memdb VFS — always available). */
async function openMemoryDb(sqlite3) {
  return sqlite3.open_v2(':memory:', OPEN_READWRITE | OPEN_CREATE, null);
}

/**
 * Copy srcDb → destDb page-for-page via the backup API.
 * A single -1 step copies every page, making dest an exact replacement of src
 * (extra tables/indexes present only in dest are dropped).
 */
async function backupFull(module, destDb, srcDb) {
  const zDest = toCString(module, 'main');
  const zSrc = toCString(module, 'main');
  try {
    const pBackup = await module._sqlite3_backup_init(destDb, zDest, srcDb, zSrc);
    if (!pBackup) throw new Error('sqlite3_backup_init failed');
    try {
      const rc = await module._sqlite3_backup_step(pBackup, -1);
      if (rc !== SQLITE_DONE) {
        throw new Error(`sqlite3_backup_step failed: ${errname(module, rc)}`);
      }
    } finally {
      await module._sqlite3_backup_finish(pBackup);
    }
  } finally {
    freeCString(module, zDest);
    freeCString(module, zSrc);
  }
}

/**
 * Export the current database as a .sqlite3 file download.
 * @param {object} sqlite3 - wa-sqlite SQLiteAPI instance
 * @param {object} module  - raw WASM module (bootSqliteAgent return value)
 * @param {number} db      - Database handle pointer
 * @param {string} filename - Suggested download filename
 */
export async function exportCartridge(sqlite3, module, db, filename = 'bobby-brain.sqlite3') {
  // 1. Snapshot the live DB into an in-memory DB (safe with active statements)
  const pMemDb = await openMemoryDb(sqlite3);
  try {
    await backupFull(module, pMemDb, db);

    // 2. Serialize the in-memory DB into a malloc'd buffer
    const zSchema = toCString(module, 'main');
    const pSize = module._malloc(8);
    let bytes;
    try {
      const pBuf = await module._sqlite3_serialize(pMemDb, zSchema, pSize, SQLITE_SERIALIZE_NORMAL);
      if (!pBuf) throw new Error('sqlite3_serialize returned NULL');
      const size = readI64(module, pSize);
      bytes = new Uint8Array(size);
      bytes.set(module.HEAPU8.subarray(pBuf, pBuf + size));
      module._sqlite3_free(pBuf);
    } finally {
      freeCString(module, zSchema);
      module._free(pSize);
    }

    // 3. Trigger download
    await saveFile(bytes, filename);
    return { success: true, bytes: bytes.length };
  } finally {
    await sqlite3.close(pMemDb);
  }
}

/**
 * Import a .sqlite3 cartridge file, replacing the current database contents.
 * The live DB handle is preserved — UDFs, update hooks, and connection-level
 * pragmas survive, so no re-registration is needed by the caller.
 * @param {object} sqlite3 - wa-sqlite SQLiteAPI instance
 * @param {object} module  - raw WASM module (bootSqliteAgent return value)
 * @param {number} db      - Live database handle pointer
 * @returns {Promise<number>} The same database handle
 */
export async function importCartridge(sqlite3, module, db) {
  // 1. Prompt user to select a .sqlite3 file
  const fileBytes = await pickFile();
  if (!fileBytes) throw new Error('File selection cancelled.');

  // 2. Load the bytes into an in-memory DB
  const pMemDb = await openMemoryDb(sqlite3);
  const size = fileBytes.length;
  const pBuf = module._sqlite3_malloc(size);
  if (!pBuf) {
    await sqlite3.close(pMemDb);
    throw new Error('sqlite3_malloc failed');
  }
  module.HEAPU8.set(fileBytes, pBuf);
  const zSchema = toCString(module, 'main');
  try {
    // raw signature: (db, zSchema, pData, szDataLo, szDataHi, szBufLo, szBufHi, mFlags)
    //
    // CRITICAL: sqlite3_deserialize references pBuf LAZILY — the page data is
    // only read out of pBuf on first access to the deserialized DB. pBuf must
    // therefore stay allocated through the backup below AND until the in-memory
    // DB is closed. Freeing it early corrupts the DB ("file is not a database").
    const rc = await module._sqlite3_deserialize(
      pMemDb, zSchema, pBuf,
      size & 0xffffffff, Math.floor(size / 4294967296), // szData (lo, hi)
      size & 0xffffffff, Math.floor(size / 4294967296), // szBuf  (lo, hi)
      SQLITE_DESERIALIZE_DEFAULT
    );
    if (rc !== SQLITE_OK) {
      throw new Error(`sqlite3_deserialize failed: ${errname(module, rc)}`);
    }

    // 3. Full replacement: back the imported DB over the live DB.
    //    This is the first access to the deserialized pages — pBuf is still alive.
    await backupFull(module, db, pMemDb);
  } finally {
    freeCString(module, zSchema);
    await sqlite3.close(pMemDb);
    module._sqlite3_free(pBuf); // safe only after the DB no longer references it
  }

  return db;
}

/**
 * Alternative export: generate a SQL dump instead of binary.
 * Emits schema objects from sqlite_master (tables, views, indexes, triggers)
 * followed by one INSERT per row. Works with any wa-sqlite build.
 */
export async function exportSqlDump(sqlite3, db, filename = 'bobby-brain.sql') {
  const lines = [];
  lines.push('-- Bobby cartridge SQL dump');
  lines.push(`-- Generated ${new Date().toISOString()}`);
  lines.push('PRAGMA foreign_keys=OFF;');
  lines.push('BEGIN TRANSACTION;');

  // 1. Schema objects, in dependency-safe order: tables → views → indexes → triggers
  //    (columns: 0=type, 1=name, 2=sql)
  for (const [type, name, sql] of await queryAll(sqlite3, db,
    "SELECT type, name, sql FROM sqlite_master " +
    "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
    "ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END, name")) {
    if (sql) lines.push(`${sql};`);
  }

  // 2. Table data (SELECT * yields values in table column order, matching VALUES(...))
  const tables = await queryAll(sqlite3, db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const [name] of tables) {
    const q = quoteIdent(name);
    const rows = await queryAll(sqlite3, db, `SELECT * FROM ${q}`);
    if (rows.length === 0) continue;
    for (const row of rows) {
      lines.push(`INSERT INTO ${q} VALUES(${row.map(sqlLiteral).join(',')});`);
    }
  }

  lines.push('COMMIT;');

  const sql = lines.join('\n');
  await saveFile(new TextEncoder().encode(sql), filename);
  return { success: true, bytes: sql.length };
}

/** Run a query and return all rows as arrays (column order preserved). */
async function queryAll(sqlite3, db, sql) {
  const rows = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      rows.push(sqlite3.row(stmt));
    }
  }
  return rows;
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Render a JS value as a SQL literal (NULL / number / blob / quoted text). */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) {
    let hex = '';
    for (let i = 0; i < v.length; i++) hex += v[i].toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
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
      await writable.write(data);
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
