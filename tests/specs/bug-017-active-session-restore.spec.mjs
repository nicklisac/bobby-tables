// BUG-017 — boot always landed on the 'default' chat instead of the
// last-used session. The global state already existed (session_context.
// active_session_id, written by setActiveSession on every switch/create —
// even a session created without chatting); boot (main.js) just hardcoded
// 'default' and clobbered it. Regression guard: create/switch through the
// real UI, reload, assert the restored session is the ACTIVE one — plus the
// stale-id fallback (most recent in list-view order when the stored session
// no longer exists).
import { test, expect } from '@playwright/test';
import {
  bootPage, waitAgent, queryAll, queryValue, createSessionViaUi,
} from '../helpers.mjs';

const ACTIVE_KEY_SQL = `SELECT value FROM session_context WHERE key = 'active_session_id'`;

test.describe('BUG-017 — boot restores the last-used session', () => {
  test('session created without chatting is ACTIVE after reload', async ({ context, page }) => {
    const name = `BUG017 Session ${Date.now().toString(36)}`;
    await bootPage(page);
    const sessionId = await createSessionViaUi(page, name);
    expect(sessionId).not.toBe('default');

    // The switch persisted the global state (no message was ever sent).
    expect(await queryValue(page, ACTIVE_KEY_SQL)).toBe(sessionId);

    // ── The refresh ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    // Boot restored it: exactly one active item in the list, and it is this
    // session (not 'default').
    const active = page.locator('#session-list .session-item.active');
    await expect(active).toHaveCount(1);
    expect(await active.getAttribute('data-session-id')).toBe(sessionId);
    // The pointer still agrees with the UI.
    expect(await queryValue(page, ACTIVE_KEY_SQL)).toBe(sessionId);
  });

  test('stale stored session falls back to the most recent (list-view order)', async ({ context, page }) => {
    const mk = (tag) => `BUG017 ${tag} ${Date.now().toString(36)}`;
    await bootPage(page);

    const idA = await createSessionViaUi(page, mk('A'));
    // >1s gap: sessions.created_at/updated_at are second-resolution, so this
    // makes B strictly more recent than A in list-view order (updated_at
    // DESC, created_at DESC).
    await new Promise((r) => setTimeout(r, 1100));
    const idB = await createSessionViaUi(page, mk('B'));
    const idC = await createSessionViaUi(page, mk('C'));
    expect([idA, idB, idC]).toHaveLength(new Set([idA, idB, idC]).size);

    // C is the stored active session; delete it out from under the app. The
    // UI delete path resets the pointer itself — this simulates the stale-id
    // case (direct SQL / cartridge-level removal).
    await queryAll(page, `DELETE FROM sessions WHERE id = ?`, [idC]);
    expect(await queryValue(page, ACTIVE_KEY_SQL)).toBe(idC);

    // ── The refresh ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    // Fallback = first row of list-view order = B (most recent), not A or
    // 'default' — and the pointer is rewritten to the fallback.
    const active = page.locator('#session-list .session-item.active');
    await expect(active).toHaveCount(1);
    expect(await active.getAttribute('data-session-id')).toBe(idB);
    expect(await queryValue(page, ACTIVE_KEY_SQL)).toBe(idB);
  });
});
