/**
 * T16: DOCUMENT CORPUS LIBRARY — FTS5 full-text search over `documents`.
 *
 * Shared by the agent UDFs (harness.js: search_documents / ingest_document,
 * plus the fetch_url / search_web auto-ingest side effects) and the
 * Documents UI (documents-ui.js).
 *
 * The corpus is derived index state (INTERNAL_TABLES): ingestion happens
 * only through these flows, never through agent execute_sql DML.
 */

import { queryAll, execParams } from './schema.js';

/**
 * Insert or refresh a document. Upsert on (source, source_ref): re-ingesting
 * the same ref updates title/content in place (the FTS5 sync triggers keep
 * the index consistent). A NULL source_ref never conflicts (SQLite treats
 * NULLs as distinct), so user documents without a ref always insert.
 *
 * @returns {Promise<{ id: number, updated: boolean }>}
 */
export async function upsertDocument(sqlite3, db, { source, sourceRef = null, title, content }) {
  if (!title || !title.trim()) throw new Error('Document title must be non-empty.');
  if (typeof content !== 'string' || content.trim() === '') throw new Error('Document content must be non-empty.');

  const src = (source && source.trim()) || 'user';
  const ref = (sourceRef && sourceRef.trim()) ? sourceRef.trim() : null;

  let existingId = null;
  if (ref !== null) {
    const rows = await queryAll(sqlite3, db,
      `SELECT id FROM documents WHERE source = ? AND source_ref = ?`, [src, ref]);
    if (rows.length) existingId = rows[0][0];
  }

  await execParams(sqlite3, db, `
    INSERT INTO documents (source, source_ref, title, content)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, source_ref) DO UPDATE SET
      title   = excluded.title,
      content = excluded.content
  `, [src, ref, title.trim(), content]);

  let id = existingId;
  if (id === null) {
    const rows = await queryAll(sqlite3, db, `SELECT last_insert_rowid()`);
    id = rows.length ? rows[0][0] : null;
  }
  return { id, updated: existingId !== null };
}

/**
 * BM25 full-text search over the corpus.
 *
 * @param {string} query - FTS5 query (plain words, "phrases", AND/OR/NOT, prefix*)
 * @param {number} [limit] - clamped to 1..50, default 10
 * @returns {Promise<Array<{ id, source, sourceRef, title, snippet, rank }>>}
 * @throws on FTS5 query-syntax errors (the UDF wraps them into an error envelope)
 */
export async function searchDocuments(sqlite3, db, query, limit = 10) {
  const lim = Math.max(1, Math.min(50, Math.trunc(Number(limit)) || 10));
  const rows = await queryAll(sqlite3, db, `
    SELECT d.id, d.source, d.source_ref, d.title,
           snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet,
           bm25(documents_fts) AS rank
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
    ORDER BY bm25(documents_fts)
    LIMIT ?
  `, [query, lim]);
  return rows.map(([id, source, sourceRef, title, snippet, rank]) => ({
    id, source, sourceRef, title, snippet, rank,
  }));
}

/**
 * Newest-first listing (no search). Used by the Documents UI when the
 * search box is empty.
 */
export async function listDocuments(sqlite3, db, { limit = 200 } = {}) {
  const lim = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 200));
  const rows = await queryAll(sqlite3, db, `
    SELECT id, source, source_ref, title, content, created_at
    FROM documents
    ORDER BY id DESC
    LIMIT ?
  `, [lim]);
  return rows.map(([id, source, sourceRef, title, content, createdAt]) => ({
    id, source, sourceRef, title, content, createdAt,
  }));
}

/**
 * Delete a document (the FTS5 sync trigger removes its index postings).
 * @returns {Promise<boolean>} true if a row was deleted
 */
export async function deleteDocument(sqlite3, db, id) {
  await execParams(sqlite3, db, `DELETE FROM documents WHERE id = ?`, [id]);
  const rows = await queryAll(sqlite3, db, `SELECT changes()`);
  return rows.length ? Number(rows[0][0]) > 0 : false;
}

/** @returns {Promise<number>} total document count */
export async function getDocumentCount(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `SELECT COUNT(*) FROM documents`);
  return rows.length ? Number(rows[0][0]) : 0;
}
