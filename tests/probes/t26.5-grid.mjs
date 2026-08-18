// Ticket 26.5 (subsystem 3) — differential output-equality probe: the
// refactored render-path row count (queryGridRows → v_grid_matrix) must
// return exactly what the pre-T26.5 computeGridRows(cards) returned.
//
// Scope note: the grid's placement / reflow / auto-pack stays a pure
// in-memory engine over the cards array (what-if computations; the T12 probe
// exercises it directly with in-memory arrays). The harmonization is the
// DB-backed self-sizing row count moving to v_grid_matrix for the render
// path (renderGrid). computeGridRows is retained as the pure oracle the
// engine's findFreeSpot scan and this probe use.
//
// Oracle:  computeGridRows (verbatim, still exported from grid.js).
// Actual:  queryGridRows (v_grid_matrix, the view-backed render-path count).
// Cross-check: the view's own distinct-row count (independent confirmation
//   that the matrix materializes exactly n_rows rows).
//
// Cards are seeded directly into dashboard_cards (bypassing addCard's
// auto-pack / reflow) so the row-count computation is tested in isolation.
// dashboard_cards is INTERNAL_TABLES — no capture triggers attach, so no
// cascade/capture suppression is needed.
//
// Run from the harness (tests/specs/t26.5-grid.spec.mjs) or the preview
// console:
//   import('/tests/probes/t26.5-grid.mjs?t=' + Date.now())
//     .then(m => m.runT265GridProbe(window.__agent.sqlite3, window.__agent.db))

import { computeGridRows, queryGridRows, listCards } from '../../src/grid.js';
import { queryAll } from '../../src/schema.js';

// Each layout: an array of [row, col, row_span, col_span].
const LAYOUTS = [
  { name: 'empty', cards: [] },
  { name: 'one-1x1-at-origin', cards: [[0, 0, 1, 1]] },
  { name: 'one-at-row5-span2', cards: [[5, 0, 2, 1]] },
  { name: 'tall-5x3-at-origin', cards: [[0, 0, 5, 3]] },
  { name: 'scattered', cards: [[0, 0, 1, 1], [1, 1, 1, 1], [3, 2, 2, 1], [6, 0, 1, 3]] },
  { name: 'buffer-boundary', cards: [[2, 0, 1, 1]] },
];

async function clearCards(sqlite3, db) {
  await queryAll(sqlite3, db, `DELETE FROM dashboard_cards`);
}

async function seedLayout(sqlite3, db, cards) {
  for (const [row, col, rowSpan, colSpan] of cards) {
    await queryAll(sqlite3, db,
      `INSERT INTO dashboard_cards (title, sql, row, col, row_span, col_span)
       VALUES (?, 'SELECT 1', ?, ?, ?, ?)`,
      [`t265 ${row},${col}`, row, col, rowSpan, colSpan]);
  }
}

export async function runT265GridProbe(sqlite3, db) {
  const R = { ok: false, steps: {} };
  try {
    const results = [];
    for (const layout of LAYOUTS) {
      await clearCards(sqlite3, db);
      await seedLayout(sqlite3, db, layout.cards);

      const cards = await listCards(sqlite3, db);
      const oracle = computeGridRows(cards); // pre-T26.5 pure JS
      const actual = await queryGridRows(sqlite3, db); // T26.5 view-backed
      const viewDistinctRows = (await queryAll(
        sqlite3, db, `SELECT COUNT(*) FROM (SELECT DISTINCT row FROM v_grid_matrix)`))[0][0];

      results.push({
        layout: layout.name,
        ok: oracle === actual && actual === viewDistinctRows,
        oracle, actual, viewDistinctRows,
      });
    }
    R.steps.layouts = { ok: results.every((r) => r.ok), results };
    R.ok = R.steps.layouts.ok;
    return R;
  } finally {
    await clearCards(sqlite3, db).catch(() => {});
  }
}
