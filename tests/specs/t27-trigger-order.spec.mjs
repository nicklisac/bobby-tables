// Ticket 27 — Trigger firing order: current_turn_id must hold the CURRENT
// turn's user-row id DURING the cascade.
//
// The probe (docs/prototypes/ticket-27-trigger-order-probe.mjs) re-registers
// a scripted fake ask_llm, drives two real cascades (each performing one
// approved data write) plus one UI-driven `!!` scratchpad write in a
// throwaway session, and asserts:
//   - each turn's turn_changesets rows carry THAT turn's user-row id
//     (pre-fix: the PREVIOUS turn's id — a session's first turn stamped 0
//     and was never rewindable),
//   - current_turn_id as observed from inside the cascade is current,
//   - T17's tool_approvals.turn_id stays consistent,
//   - T3 rewind (rewindToBeforeTurn) undoes the right turn's rows,
//   - scratchpad -M attribution is unaffected.
//
// This spec is the guard on the empirically-pinned trigger firing order
// (same-type triggers fire in REVERSE creation order, verified in the pinned
// wa-sqlite build): if a future vendor upgrade changes it, this test fails
// loudly instead of silently misattributing changesets.
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T27 — trigger firing order (current_turn_id during the cascade)', () => {
  test('each turn stamps its own changesets; rewind undoes the right turn', async ({ page }) => {
    // Two fake-LLM cascades + approval round-trips + a UI scratchpad leg +
    // cleanup — slower than the sub-5s suite norm; 60s is the ceiling.
    test.setTimeout(60_000);
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const mod = await import(`/docs/prototypes/ticket-27-trigger-order-probe.mjs?t=${Date.now()}`);
      return mod.runT27Probe();
    });

    expect(result.fatal, result.fatal).toBeUndefined();
    expect(result.checks, JSON.stringify(result.facts, null, 2)).toEqual({
      okAttribution: true,
      okApprovals: true,
      okRewind: true,
      okScratch: true,
    });
    expect(result.verdict).toBe('GO');
    expect(result.cleaned).toBe(true);
  });
});
