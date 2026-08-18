// Ticket 26.5 (subsystem 2) — compaction consumes v_turn_boundaries.
//
// Output equality: the differential probe (tests/probes/t26.5-compaction.mjs)
// re-runs the pre-T26.5 JS walk-back + estimator as oracles and compares them
// against the refactored planCompaction / estimateActiveContextTokens across
// a budget sweep, with and without a compaction row (the tau guard included).
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T26.5 sub2 — compaction via v_turn_boundaries', () => {
  test('plan + estimate output-equality vs the old JS walk', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const mod = await import(`/tests/probes/t26.5-compaction.mjs?t=${Date.now()}`);
      return mod.runT265CompactionProbe(sqlite3, db);
    });

    const failures = Object.entries(result.steps)
      .filter(([, s]) => !s.ok)
      .map(([name, s]) => ({ name, ...s }));
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);

    // The sweep must have produced non-trivial plans (not all-null): with a
    // mid-sized budget the watermark lands strictly inside the region.
    const mid = result.steps.plansNoCompaction.results.find((r) => r.keepBudget === 200);
    expect(mid.ok).toBe(true);
    expect(mid.oracle, 'a mid budget yields a real plan').not.toBeNull();
    expect(mid.oracle.watermarkId).toBeLessThan(mid.oracle.firstRetainedId);
  });
});
