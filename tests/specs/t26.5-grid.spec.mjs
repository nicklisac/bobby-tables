// Ticket 26.5 (subsystem 3) — the grid render path consumes v_grid_matrix.
//
// Output equality: the differential probe (tests/probes/t26.5-grid.mjs)
// re-runs the pre-T26.5 computeGridRows as an oracle and compares it against
// the refactored queryGridRows (v_grid_matrix) across several card layouts.
// A second check renders the grid and asserts the DOM's gridTemplateRows
// reflects the view's row count (the full render path, not just the data fn).
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T26.5 sub3 — grid via v_grid_matrix', () => {
  test('row-count output-equality vs the old computeGridRows', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const mod = await import(`/tests/probes/t26.5-grid.mjs?t=${Date.now()}`);
      return mod.runT265GridProbe(sqlite3, db);
    });

    const failures = Object.entries(result.steps)
      .filter(([, s]) => !s.ok)
      .map(([name, s]) => ({ name, ...s }));
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);

    // The sweep must span the self-sizing range: empty → 3, and a layout
    // that pushes past the buffer → well above 3.
    const rows = result.steps.layouts.results.map((r) => r.oracle);
    expect(rows).toContain(3); // empty layout
    expect(Math.max(...rows)).toBeGreaterThan(3); // a real self-sized layout
  });

  test('renderGrid gridTemplateRows reflects the view row count', async ({ page }) => {
    await bootPage(page);

    const { viewRows, domRows } = await page.evaluate(async () => {
      const { sqlite3, db, gridUi } = window.__agent;
      const { queryAll, execParams } = await import('/src/schema.js');
      // Seed a layout that self-sizes past the minimum (row 5, span 2 → 10).
      await execParams(sqlite3, db, `DELETE FROM dashboard_cards`);
      await execParams(sqlite3, db,
        `INSERT INTO dashboard_cards (title, sql, row, col, row_span, col_span)
         VALUES ('t265 ui', 'SELECT 1', 5, 0, 2, 1)`);
      const viewRows = (await queryAll(
        sqlite3, db, `SELECT MAX(row) + 1 FROM v_grid_matrix`))[0][0];
      await gridUi.renderGrid();
      const grid = document.getElementById('dashboard-grid');
      const m = grid.style.gridTemplateRows.match(/repeat\((\d+),/);
      return { viewRows, domRows: m ? Number(m[1]) : null };
    });

    expect(viewRows).toBe(10);
    expect(domRows).toBe(viewRows);
  });
});
