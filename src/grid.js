/**
 * GRID ENGINE — T11: 3-pane workstation, right-pane 3×3 reactive canvas.
 *
 * Pure engine (no DOM): `dashboard_cards` CRUD, placement validation
 * (bounds + non-overlap), auto-pack, read-only SQL enforcement, card SQL
 * execution, and the card→base-table dependency resolver that the
 * change-triggered reactivity (T18 groundwork) and the UI layer use.
 *
 * Locked design (user-confirmed 2026-08-14):
 *   - GLOBAL to the brain (no session_id) — a workstation view over the data.
 *   - Cards run READ-ONLY SQL only (single SELECT/WITH/EXPLAIN statement) —
 *     never DML/DDL, so card execution stays outside T3's changeset capture
 *     and is safe to re-run at any time.
 *   - Fixed 3×3 grid (9 cells). Free placement: explicit (row, col) top-left
 *     + (row_span, col_span) merged-cell extent, 1–3 each. Every add/move/
 *     resize is validated for bounds + overlap; "add" auto-packs the first
 *     fitting spot when no position is given.
 *   - dashboard_cards is UI state: it is in INTERNAL_TABLES (schema.js), so
 *     no capture triggers attach, rewinds never touch the grid, and card CRUD
 *     emits no data_change events.
 *
 * Exposed on the live handle as `window.__agent.grid` for probes.
 */

import { queryAll, execParams } from './schema.js';

export const GRID_ROWS = 3;
export const GRID_COLS = 3;
export const CARD_ROW_CAP = 100; // rows kept per card render (bounds the DOM)

// ── Read-only SQL enforcement ─────────────────────────────────────────

/**
 * Validate that a card's SQL is a single read-only statement.
 * Returns { ok: true } or { ok: false, reason }.
 *
 * Allowed: SELECT, EXPLAIN, and WITH (as long as the CTE is not
 * data-modifying — `WITH … INSERT/UPDATE/DELETE/REPLACE` is a write).
 * Mirrors T9's scratchpad classification (main.js classifyStatement) but
 * STRICTER: no DML, no DDL, no PRAGMA/VACUUM, no transaction control.
 *
 * Comments and string literals are stripped BEFORE the checks, so a leading
 * line (`--`) or block comment can't masquerade as the statement type, and a
 * `;` inside a comment or string literal can't trip the multi-statement check.
 */
export function isReadOnlySql(sql) {
  const raw = String(sql || '').trim();
  if (!raw) return { ok: false, reason: 'Empty SQL' };
  const t = stripSqlLiterals(raw).replace(/;+\s*$/, '').trim();
  if (!t) return { ok: false, reason: 'Empty SQL' };
  if (t.includes(';')) return { ok: false, reason: 'One statement per card (found multiple)' };
  const first = (t.split(/\s+/)[0] || '').toUpperCase();
  if (first === 'SELECT' || first === 'EXPLAIN') return { ok: true };
  if (first === 'WITH') {
    if (/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t)) {
      return { ok: false, reason: 'Data-modifying CTE — cards run read-only SELECTs' };
    }
    return { ok: true };
  }
  return { ok: false, reason: `Only SELECT / WITH / EXPLAIN queries are allowed (got "${first}")` };
}

// ── Placement ─────────────────────────────────────────────────────────

/**
 * Validate a placement against the fixed 3×3 grid and existing cards.
 * `cards` = rows shaped like { id, title, row, col, row_span, col_span }.
 * `ignoreId` excludes one card (used when editing/moving that card itself).
 * Returns { ok: true } or { ok: false, reason }.
 */
export function validatePlacement(cards, row, col, rowSpan, colSpan, ignoreId = null) {
  const r = Number(row), c = Number(col), rs = Number(rowSpan), cs = Number(colSpan);
  if (![r, c, rs, cs].every(n => Number.isInteger(n))) {
    return { ok: false, reason: 'Grid position/span must be integers' };
  }
  if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) {
    return { ok: false, reason: `Position out of bounds (grid is ${GRID_ROWS}×${GRID_COLS}, 0-based)` };
  }
  if (rs < 1 || rs > GRID_ROWS || cs < 1 || cs > GRID_COLS) {
    return { ok: false, reason: `Span out of bounds (1–${GRID_ROWS})` };
  }
  if (r + rs > GRID_ROWS) return { ok: false, reason: 'Card extends past the bottom edge' };
  if (c + cs > GRID_COLS) return { ok: false, reason: 'Card extends past the right edge' };
  for (const card of cards) {
    if (ignoreId != null && card.id === ignoreId) continue;
    const overlaps =
      r < card.row + card.row_span && card.row < r + rs &&
      c < card.col + card.col_span && card.col < c + cs;
    if (overlaps) return { ok: false, reason: `Overlaps card "${card.title}"` };
  }
  return { ok: true };
}

/**
 * Auto-pack: first free spot (scan order: row-major) that fits the span.
 * Returns { row, col } or null (grid full for that span).
 */
export function findFreeSpot(cards, rowSpan, colSpan) {
  for (let r = 0; r + Number(rowSpan) <= GRID_ROWS; r++) {
    for (let c = 0; c + Number(colSpan) <= GRID_COLS; c++) {
      if (validatePlacement(cards, r, c, rowSpan, colSpan).ok) return { row: r, col: c };
    }
  }
  return null;
}

// ── CRUD ──────────────────────────────────────────────────────────────

/** List all cards (global — no session filter), ordered by id. */
export async function listCards(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `
    SELECT id, title, sql, row, col, row_span, col_span, created_at, updated_at
    FROM dashboard_cards ORDER BY id ASC
  `);
  return rows.map(([id, title, sql, row, col, row_span, col_span, created_at, updated_at]) => ({
    id, title, sql, row, col, row_span, col_span, created_at, updated_at,
  }));
}

/**
 * Add a card. `row`/`col` may be omitted (or null) → auto-pack the first
 * fitting spot. Throws on validation failure (bad SQL, bounds, overlap,
 * no room). Returns the new card row.
 */
export async function addCard(sqlite3, db, { title, sql, row = null, col = null, rowSpan = 1, colSpan = 1 }) {
  if (!title || !String(title).trim()) throw new Error('Card title is required');
  const ro = isReadOnlySql(sql);
  if (!ro.ok) throw new Error(ro.reason);
  const cards = await listCards(sqlite3, db);
  let pos;
  if (row == null || col == null) {
    pos = findFreeSpot(cards, rowSpan, colSpan);
    if (!pos) throw new Error(`No room for a ${rowSpan}×${colSpan} card — resize or delete a card first`);
  } else {
    pos = { row: Number(row), col: Number(col) };
  }
  const v = validatePlacement(cards, pos.row, pos.col, rowSpan, colSpan);
  if (!v.ok) throw new Error(v.reason);
  await execParams(sqlite3, db, `
    INSERT INTO dashboard_cards (title, sql, row, col, row_span, col_span)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [String(title).trim(), String(sql).trim(), pos.row, pos.col, Number(rowSpan), Number(colSpan)]);
  const rows = await queryAll(sqlite3, db, 'SELECT last_insert_rowid()');
  const id = rows[0][0];
  const all = await listCards(sqlite3, db);
  return all.find(c => c.id === id);
}

/**
 * Update a card (title and/or sql and/or placement). All provided fields are
 * validated together against the other cards (self excluded). Throws on
 * validation failure. Returns the updated card row.
 */
export async function updateCard(sqlite3, db, id, patch = {}) {
  const cards = await listCards(sqlite3, db);
  const existing = cards.find(c => c.id === id);
  if (!existing) throw new Error(`Card ${id} not found`);

  // Spans accept camelCase (rowSpan) or the SQLite column name (row_span).
  const rowSpanPatch = patch.rowSpan ?? patch.row_span;
  const colSpanPatch = patch.colSpan ?? patch.col_span;
  const next = {
    title: patch.title !== undefined ? String(patch.title).trim() : existing.title,
    sql: patch.sql !== undefined ? String(patch.sql).trim() : existing.sql,
    row: patch.row !== undefined ? Number(patch.row) : existing.row,
    col: patch.col !== undefined ? Number(patch.col) : existing.col,
    row_span: rowSpanPatch !== undefined ? Number(rowSpanPatch) : existing.row_span,
    col_span: colSpanPatch !== undefined ? Number(colSpanPatch) : existing.col_span,
  };
  if (!next.title) throw new Error('Card title is required');
  const ro = isReadOnlySql(next.sql);
  if (!ro.ok) throw new Error(ro.reason);
  const v = validatePlacement(cards, next.row, next.col, next.row_span, next.col_span, id);
  if (!v.ok) throw new Error(v.reason);

  await execParams(sqlite3, db, `
    UPDATE dashboard_cards
    SET title = ?, sql = ?, row = ?, col = ?, row_span = ?, col_span = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [next.title, next.sql, next.row, next.col, next.row_span, next.col_span, id]);
  const all = await listCards(sqlite3, db);
  return all.find(c => c.id === id);
}

/** Remove a card. Returns true if a row was deleted. */
export async function removeCard(sqlite3, db, id) {
  await execParams(sqlite3, db, 'DELETE FROM dashboard_cards WHERE id = ?', [id]);
  return !(await listCards(sqlite3, db)).some(c => c.id === id);
}

// ── Card SQL execution ────────────────────────────────────────────────

/**
 * Run a card's read-only SQL. Returns
 *   { columns: [...], values: [[...]], truncated, ms, error: null }
 * on success, or
 *   { columns: [], values: [], truncated: false, ms, error: 'message' }
 * on failure (SQL errors are reported, not thrown — a card shows its error).
 * Rows are capped at CARD_ROW_CAP.
 */
export async function runCardSql(sqlite3, db, sql) {
  const t0 = performance.now();
  try {
    const columns = [];
    const values = [];
    let truncated = false;
    for await (const stmt of sqlite3.statements(db, sql)) {
      const cols = sqlite3.column_names(stmt);
      if (!cols.length) continue; // non-row-returning statement (unexpected for read-only)
      columns.push(...cols);
      while (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) {
        values.push(sqlite3.row(stmt));
        if (values.length >= CARD_ROW_CAP) { truncated = true; break; }
      }
    }
    return { columns, values, truncated, ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { columns: [], values: [], truncated: false, ms: Math.round(performance.now() - t0), error: e.message };
  }
}

// ── Dependency resolution (T18 groundwork) ────────────────────────────

/**
 * Strip string literals and comments from SQL so identifier scanning doesn't
 * match table names inside quotes. 'x' → '', "x" stays (quoted identifier —
 * it IS an identifier), -- and /* … *\/ comments removed.
 */
function stripSqlLiterals(sql) {
  return String(sql)
    // single-quoted string literals ('' is an escaped quote inside)
    .replace(/'(?:[^']|'')*'/g, "''")
    // line comments
    .replace(/--[^\n]*/g, ' ')
    // block comments (non-greedy)
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Extract table/view references (FROM / JOIN targets) from a SQL statement.
 * Subqueries are handled for free: `FROM (SELECT … FROM t)` — the `(` never
 * matches the identifier pattern, and the inner FROM t is caught by the same
 * global scan. Quoted identifiers ("my table") are not matched (accepted
 * heuristic limitation — see resolveCardTables).
 */
function extractTableRefs(sql) {
  const refs = new Set();
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_$]*)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) refs.add(m[1].toLowerCase());
  return refs;
}

/**
 * Resolve the BASE TABLES a card's SQL depends on (for change-triggered
 * re-runs): extract FROM/JOIN references, then recursively expand views to
 * their underlying tables (cycle-guarded). Names that are neither tables nor
 * views (CTE names, dropped objects) are dropped.
 *
 * Returns a Set of lowercased table names.
 *
 * This is the groundwork T18 builds on: when `v_dashboard_*` views arrive,
 * the same expansion maps a card on a view to the base tables whose changes
 * should re-run it.
 */
export async function resolveCardTables(sqlite3, db, sql) {
  const master = await queryAll(sqlite3, db,
    `SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`);
  const byName = new Map();
  for (const [name, type, defSql] of master) byName.set(name.toLowerCase(), { type, defSql });

  const out = new Set();
  const visiting = new Set(); // cycle guard (recursive views)

  const expand = (name) => {
    const key = name.toLowerCase();
    if (visiting.has(key) || out.has(key)) return;
    const obj = byName.get(key);
    if (!obj) return; // CTE name or unknown object — not a base table dependency
    if (obj.type === 'table') {
      out.add(key);
      return;
    }
    // view: expand its definition (cycle-guarded)
    visiting.add(key);
    for (const ref of extractTableRefs(stripSqlLiterals(obj.defSql || ''))) expand(ref);
    visiting.delete(key);
  };

  for (const ref of extractTableRefs(stripSqlLiterals(sql))) expand(ref);
  return out;
}

/**
 * Which of `cards` are affected by changes to the tables in `changedTables`?
 * Returns the affected card rows (re-resolving dependencies live, so newly
 * created/dropped views are picked up without a cache).
 */
export async function affectedCards(sqlite3, db, cards, changedTables) {
  const changed = new Set(changedTables.map(t => String(t).toLowerCase()));
  const affected = [];
  for (const card of cards) {
    const deps = await resolveCardTables(sqlite3, db, card.sql);
    for (const t of changed) if (deps.has(t)) { affected.push(card); break; }
  }
  return affected;
}
