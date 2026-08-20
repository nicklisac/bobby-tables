// Ticket 31 — System prompt identity (Tables voice) + welcome card.
//
// Guards:
//   - the canonical SYSTEM_PROMPT (single source of truth in src/schema.js)
//     is installed into system_config AND the system message row at boot,
//   - the migration is version-gated by prompt_version: a second boot is a
//     no-op (byte-stable — the prompt is the KV-cache prefix, T2),
//   - the welcome card speaks in Tables' first person (both states) and the
//     configured state's example chips route through the normal send path.
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, queryAll } from '../helpers.mjs';

const PROMPT_START = 'You are Tables. You live inside a SQLite database in the user\'s browser.';
const PROMPT_END = 'If asked who you are, answer plainly: "I\'m Tables. I live in the SQLite database in this browser tab."';

test.describe('T31 — system prompt identity + welcome card', () => {
  test('prompt installed at boot; version-gated no-op on second boot', async ({ page }) => {
    await bootPage(page);

    const first = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } = await import('/src/schema.js');
      const rows = [];
      for await (const stmt of sqlite3.statements(db, `SELECT key, value FROM system_config WHERE key IN ('system_prompt','prompt_version')`)) {
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      const sysRows = [];
      for await (const stmt of sqlite3.statements(db, `SELECT content FROM messages WHERE role = 'system'`)) {
        while (await sqlite3.step(stmt) === 100) sysRows.push(sqlite3.row(stmt));
      }
      return { canonical: SYSTEM_PROMPT, version: SYSTEM_PROMPT_VERSION, cfg: Object.fromEntries(rows), sysRows };
    });

    expect(first.cfg.prompt_version).toBe(String(first.version));
    expect(first.cfg.system_prompt).toBe(first.canonical);
    expect(first.sysRows.length).toBe(1);
    expect(first.sysRows[0][0]).toBe(first.canonical);
    expect(first.canonical.startsWith(PROMPT_START)).toBe(true);
    expect(first.canonical.endsWith(PROMPT_END)).toBe(true);
    expect(first.canonical).toContain('That\'s not a metaphor. You are tables.');

    // Second boot: version already current → no re-migration (byte-stable).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    const second = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, `SELECT value FROM system_config WHERE key = 'system_prompt'`)) {
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows[0][0];
    });
    expect(second).toBe(first.canonical);
  });

  test('welcome card: first-person voice, both states; chips send a real message', async ({ page }) => {
    await bootPage(page);

    // Unconfigured state (fresh profile — no provider in localStorage).
    let card = page.locator('.welcome-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('I\'m Tables. I live in the SQLite database in this tab');
    await expect(card).toContainText('configure provider');
    expect(await page.locator('.welcome-chip').count()).toBe(0);

    // Configured state: fake a provider, reload, chips appear.
    await page.evaluate(() => {
      localStorage.setItem('sql-agent-config', JSON.stringify({ provider: 'gemini', apiKey: 'test-key' }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    await page.waitForSelector('#user-input:not([disabled])', { timeout: 15_000 });

    card = page.locator('.welcome-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('everything I know is a table I can query');
    expect(await page.locator('.welcome-chip').count()).toBe(3);

    // Clicking a chip routes through the normal send path → a user row lands.
    // The fake provider makes the LLM call fail, but the user row is inserted
    // BEFORE ask_llm runs, so it persists regardless. Wait for the turn to
    // settle on the DOM (send button re-enabled), never by polling mid-turn.
    const before = (await queryAll(page, `SELECT COUNT(*) FROM messages WHERE role = 'user'`))[0][0];
    await page.locator('.welcome-chip').first().click();
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 30_000 });
    const after = (await queryAll(page, `SELECT COUNT(*) FROM messages WHERE role = 'user'`))[0][0];
    expect(after).toBe(before + 1);

    // Tidy up: drop the fake provider so other tests see a fresh profile.
    await page.evaluate(() => localStorage.removeItem('sql-agent-config'));
  });
});
