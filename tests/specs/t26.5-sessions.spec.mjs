// Ticket 26.5 (subsystem 5) — listSessions consumes v_session_summary.
//
// Output equality: the differential probe (tests/probes/t26.5-sessions.mjs)
// re-runs the pre-T26.5 raw-`sessions` listSessions as an oracle and compares
// the full returned array against the refactored v_session_summary-backed
// listSessions, across the display-name normalization branches (normal /
// padded / empty / whitespace) and the updated_at/created_at ordering.
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T26.5 sub5 — listSessions via v_session_summary', () => {
  test('listSessions output-equality vs the old raw-sessions scan', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const mod = await import(`/tests/probes/t26.5-sessions.mjs?t=${Date.now()}`);
      return mod.runT265SessionsProbe(sqlite3, db);
    });

    const failures = Object.entries(result.steps)
      .filter(([, s]) => !s.ok)
      .map(([name, s]) => ({ name, ...s }));
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);

    // The normalization branches must have produced distinct, correct names.
    const { names } = result.steps.spotChecks;
    expect(names.s1).toBe('Alpha');
    expect(names.s2).toBe('Beta');
    expect(names.s3).toBe('Untitled Session');
    expect(names.s4).toBe('Untitled Session');
  });
});
