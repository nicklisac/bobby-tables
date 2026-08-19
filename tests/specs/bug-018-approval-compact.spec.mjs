// BUG-018 — two chat-pane rendering defects behind one "the screen is a bear"
// report:
//  1. The T17 approval notice rendered the full SQL expanded (label row +
//     SQL block + decision row) — a "bear on the screen". It is now
//     pre-compacted like the BUG-009 tool-call chip: one-line summary
//     (label + collapsed SQL + timestamp), expandable to the full SQL, with
//     the [Approve]/[Reject] buttons OUTSIDE the <details> so the live
//     decision path never requires an expand click.
//  2. The BUG-009 tool-call chip sat inside a .message with white-space:
//     pre-wrap, so the template's leading/trailing newlines rendered as full
//     blank lines above AND below the chip (measured 42px each). The
//     toolcall-only message and the chip now use white-space: normal.
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig } from '../helpers.mjs';

const FAKE_REPLY = 'bug-018-done';
const WRITE_SQL = `DELETE FROM sample_data WHERE category = 'Electronics' AND value > 30 -- longish write for the one-line summary`;

/** Fake LLM: first call issues `toolSql` via execute_sql, second replies. */
function routeToolTurn(page, toolSql) {
  let calls = 0;
  return page.route('**/chat/completions', (route) => {
    calls++;
    const body = calls === 1
      ? {
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'b18-1',
                type: 'function',
                function: { name: 'execute_sql', arguments: JSON.stringify({ query: toolSql }) },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }
      : {
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test.describe('BUG-018 — pre-compacted approval notice + chip whitespace', () => {
  test('approval widget is one line until expanded; buttons never require expanding', async ({ page }) => {
    test.setTimeout(60_000);
    await routeToolTurn(page, WRITE_SQL);
    await seedConfig(page, {
      provider: 'gemini',
      apiKey: 'bug-018-fake-key',
      isConfigured: true,
      model: 'gemini-2.5-flash',
    });
    await bootPage(page);

    await page.fill('#user-input', 'please run that write');
    await page.click('#send-btn');

    // The live (pending) widget: pre-compacted, buttons visible collapsed.
    const widget = page.locator('.approval-widget').first();
    await widget.waitFor({ timeout: 20_000 });
    const approveBtn = page.locator('#messages button:has-text("Approve")').first();
    await approveBtn.waitFor({ timeout: 20_000 });

    const pending = await widget.evaluate((w) => {
      const d = w.querySelector('.approval-details');
      return {
        open: d.open,
        name: w.querySelector('.approval-name')?.textContent,
        summary: w.querySelector('.approval-summary')?.textContent || '',
        closedHeight: w.getBoundingClientRect().height,
      };
    });
    expect(pending.open, 'pending widget starts collapsed').toBe(false);
    expect(pending.name).toBe('Approval Required');
    // The one-line summary carries the (flattened) SQL without expansion.
    expect(pending.summary).toContain('DELETE FROM sample_data');
    expect(pending.summary).not.toContain('\n');

    // Collapsed must actually hide the SQL block: opening it grows the box.
    const grown = await widget.evaluate(async (w) => {
      const d = w.querySelector('.approval-details');
      const closed = w.getBoundingClientRect().height;
      d.open = true;
      await new Promise((r) => requestAnimationFrame(r));
      const open = w.getBoundingClientRect().height;
      d.open = false;
      return { closed, open };
    });
    expect(grown.open - grown.closed, 'expanding reveals the SQL block').toBeGreaterThanOrEqual(20);

    // The decision path works from the COLLAPSED state (no expand click).
    await approveBtn.click();
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });

    // The widget flipped to a static decided record, still compact.
    const decided = await widget.evaluate((w) => {
      const d = w.querySelector('.approval-details');
      const h = (sel) => {
        const el = w.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : null;
      };
      return {
        open: d.open,
        decided: w.dataset.decided || null,
        name: w.querySelector('.approval-name')?.textContent,
        time: w.querySelector('.approval-time')?.textContent || '',
        hasButtons: !!w.querySelector('.approval-btn'),
        sql: (w.querySelector('.approval-sql pre')?.textContent || ''),
        nameH: h('.approval-name'),
        timeH: h('.approval-time'),
      };
    });
    expect(decided.decided).toBe('approved');
    expect(decided.open, 'decided widget stays collapsed').toBe(false);
    expect(decided.name).toBe('Write Approved');
    expect(decided.time).toContain('·');
    expect(decided.hasButtons, 'buttons are replaced by the decided record').toBe(false);
    expect(decided.sql).toContain('DELETE FROM sample_data');
    // The timestamp must stay on the summary's single line (it used to wrap
    // to 3 lines — "·" / "2026-08-19" / "15:03:21" — and stretch the row).
    expect(decided.timeH, `timestamp height (${decided.timeH}px) vs label (${decided.nameH}px)`).toBeLessThanOrEqual(decided.nameH + 2);
  });

  test('tool-call chip message hugs the chip (no pre-wrap blank lines)', async ({ page }) => {
    await bootPage(page);

    // Seed a minimal tool-call turn (no LLM needed; cascade suppressed).
    const result = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const toolCallsJson = JSON.stringify([{
        id: 'call_b18',
        type: 'function',
        function: { name: 'execute_sql', arguments: JSON.stringify({ query: 'SELECT 1 AS x' }) },
      }]);
      const toolResultJson = JSON.stringify({ columns: ['x'], values: [[1]] });
      const rows = [
        [9001, 'default', 'user', 'bug 018 measure me', null, null],
        [9002, 'default', 'assistant', '', toolCallsJson, null],
        [9003, 'default', 'tool', toolResultJson, 'call_b18'],
      ];
      for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
      for (const [id, sid, role, content, tc, tci] of rows) {
        for await (const st of sqlite3.statements(db, `
          INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)
        `)) {
          sqlite3.bind_collection(st, [id, sid, role, content, tc, tci]);
          await sqlite3.step(st);
        }
      }
      for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
      await window.__agent.renderMessages();

      const chip = document.querySelector('.toolcall-chip');
      if (!chip) return { error: 'no chip rendered' };
      const msg = chip.closest('.message');
      const h = (el) => Math.round(el.getBoundingClientRect().height * 100) / 100;
      const closed = { msg: h(msg), chip: h(chip) };
      // The expanded state must not gain phantom lines either (the template
      // newline between <summary> and .toolcall-args used to render as blanks).
      chip.open = true;
      const open = { msg: h(msg), chip: h(chip) };
      return { msgClass: msg.className, closed, open };
    });
    expect(result.error, 'chip rendered').toBeUndefined();

    // The BUG: pre-wrap rendered the template's leading/trailing newlines as
    // blank lines — the message box was 115px around a 31px chip. Now the
    // message hugs the chip (2px tolerance for sub-pixel rounding), closed
    // AND expanded.
    expect(result.msgClass).toContain('toolcall-only');
    expect(result.closed.msg - result.closed.chip,
      `closed: message (${result.closed.msg}px) must hug the chip (${result.closed.chip}px)`).toBeLessThanOrEqual(2);
    expect(result.open.msg - result.open.chip,
      `open: message (${result.open.msg}px) must hug the chip (${result.open.chip}px)`).toBeLessThanOrEqual(2);

    // Cleanup the seeded rows (fresh context, but keep the brain tidy).
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
      for await (const s of sqlite3.statements(db, `DELETE FROM messages WHERE id IN (9001, 9002, 9003)`)) await sqlite3.step(s);
      for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
    });
  });
});
