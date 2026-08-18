// Ticket 26.5 (subsystem 4) — chat-render consumes v_tool_call_queries.
//
// Output equality: the differential probe (tests/probes/t26.5-tool-calls.mjs)
// re-runs the pre-T26.5 JSON.parse tool-calls loop as an oracle and compares
// the resulting (tool_call_id → query) map against the refactored
// v_tool_call_queries-backed map, across every argument shape + corruption
// the old loop tolerated (object/string args, no-query, empty, malformed
// outer/inner JSON, non-assistant, multi-call, falsy query, duplicate id).
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T26.5 sub4 — chat-render via v_tool_call_queries', () => {
  test('toolCallQueries map output-equality vs the old JSON.parse loop', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const mod = await import(`/tests/probes/t26.5-tool-calls.mjs?t=${Date.now()}`);
      return mod.runT265ToolCallsProbe(sqlite3, db);
    });

    const failures = Object.entries(result.steps)
      .filter(([, s]) => !s.ok)
      .map(([name, s]) => ({ name, ...s }));
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);

    // The sweep must have produced real entries (not an empty map): the
    // object-args and string-args queries are both extracted.
    const entries = result.steps.mapEquality.actual;
    expect(entries.some(([, q]) => q === 'SELECT 1')).toBe(true);
    expect(entries.some(([, q]) => q === 'hello world')).toBe(true);
  });
});
