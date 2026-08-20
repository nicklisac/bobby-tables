// T31 — Saved provider profiles (BUG-020).
//
// The bug: the LLM config was a single flat object, so saving a second
// provider overwrote the first provider's API key — the user re-typed the key
// on every switch. The fix: a named multi-profile store in localStorage
// (deliberately NOT the brain DB, so a .sqlite3 cartridge export can never
// leak keys), with a saved-providers panel in the config modal.
//
// Guards:
//   1. The store module — legacy migration, upsert, switch (BUG-020 repro),
//      delete, key masking (exercised on the real shipped module).
//   2. The real config-modal UI — create two profiles, switch back, both keys
//      survive and the right one is active.
//   3. The cartridge invariant — a saved API key is in localStorage but NEVER
//      in the brain's IDB blocks (so VACUUM INTO can't leak it).
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, idbDump } from '../helpers.mjs';

const STORE_KEY = 'sql-agent-providers';
const LEGACY_KEY = 'sql-agent-config';

const readStore = (page) =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, STORE_KEY);

// The store-module tests import the real module in-page, which requires the
// page to be on the app origin (a bare '/src/…' specifier resolves against the
// document base). Navigate first; a full agent boot is not needed.
const toOrigin = (page) => page.goto('/', { waitUntil: 'domcontentloaded' });

test.describe('T31 — provider store module', () => {
  test('migrate + upsert + switch preserves keys (BUG-020 repro)', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/provider-store.js');
      localStorage.removeItem('sql-agent-providers');
      localStorage.removeItem('sql-agent-config');

      // (1) Legacy single-object config migrates to the first profile.
      localStorage.setItem('sql-agent-config', JSON.stringify({
        provider: 'gemini', apiKey: 'K-LEGACY', model: 'gemini-2.5-flash',
      }));
      const migrated = m.migrateLegacyConfig();
      const first = migrated.profiles[0];

      // (2) A second profile is added; switching to it must NOT touch the
      //     first profile's key (the BUG-020 repro).
      const second = m.newProfile();
      second.name = 'B';
      second.provider = 'openai';
      second.url = 'http://localhost:11434/v1';
      second.apiKey = 'K-SECOND';
      m.upsertProfile(second);
      m.setActiveProfile(second.id);

      // (3) Switch back to the first.
      m.setActiveProfile(first.id);
      const store = m.loadStore();

      return {
        legacyGone: localStorage.getItem('sql-agent-config') === null,
        migratedActive: migrated.activeId === first.id,
        firstKey: store.profiles.find((p) => p.id === first.id).apiKey,
        secondKey: store.profiles.find((p) => p.id === second.id).apiKey,
        activeId: store.activeId,
        firstId: first.id,
        masked: m.maskKey('sk-ant-abcdef123456'),
      };
    });

    expect(r.legacyGone).toBe(true);
    expect(r.migratedActive).toBe(true);
    expect(r.firstKey).toBe('K-LEGACY'); // survived the second profile + switch
    expect(r.secondKey).toBe('K-SECOND');
    expect(r.activeId).toBe(r.firstId);
    expect(r.masked).toBe('••••3456');
  });

  test('delete of the active profile re-activates the first remaining', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/provider-store.js');
      localStorage.removeItem('sql-agent-providers');
      localStorage.removeItem('sql-agent-config');
      const a = m.newProfile(); a.name = 'A'; a.apiKey = 'KA';
      const b = m.newProfile(); b.name = 'B'; b.apiKey = 'KB';
      m.upsertProfile(a);
      m.upsertProfile(b);
      m.setActiveProfile(b.id);
      m.deleteProfile(b.id); // delete the active one
      const store = m.loadStore();
      return {
        count: store.profiles.length,
        activeId: store.activeId,
        aId: a.id,
        survivingKey: store.profiles[0].apiKey,
      };
    });
    expect(r.count).toBe(1);
    expect(r.activeId).toBe(r.aId);
    expect(r.survivingKey).toBe('KA');
  });
});

test.describe('T31 — config-modal UI', () => {
  test('create two profiles, switch back, both keys survive (BUG-020 end-to-end)', async ({ page }) => {
    await bootPage(page); // unconfigured boot is fine — the agent boots for !SQL

    // Create profile A (Gemini).
    await page.click('#btn-toggle-config');
    await page.fill('#config-profile-name', 'A');
    await page.selectOption('#config-provider', 'gemini');
    await page.fill('#config-model', 'gemini-2.5-flash');
    await page.fill('#config-key', 'KEY-A-SECRET');
    await page.click('#config-apply');
    await waitAgent(page);

    // Create profile B (OpenAI-compatible) — the act that used to wipe A's key.
    await page.click('#btn-toggle-config');
    await page.click('#btn-new-provider');
    await page.fill('#config-profile-name', 'B');
    await page.selectOption('#config-provider', 'openai');
    await page.fill('#config-url', 'http://localhost:11434/v1');
    await page.fill('#config-model', 'llama3.2');
    await page.fill('#config-key', 'KEY-B-SECRET');
    await page.click('#config-apply');
    await waitAgent(page);

    const before = await readStore(page);
    const a = before.profiles.find((p) => p.name === 'A');
    const b = before.profiles.find((p) => p.name === 'B');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.apiKey).toBe('KEY-A-SECRET'); // survived B's creation
    expect(b.apiKey).toBe('KEY-B-SECRET');

    // Switch back to A via [Use].
    await page.click('#btn-toggle-config');
    await page.click(`#provider-list .provider-row[data-id="${a.id}"] button[data-action="use"]`);
    await waitAgent(page);

    const after = await readStore(page);
    expect(after.activeId).toBe(a.id);
    expect(after.profiles.find((p) => p.id === a.id).apiKey).toBe('KEY-A-SECRET');
    expect(after.profiles.find((p) => p.id === b.id).apiKey).toBe('KEY-B-SECRET');
  });

  test('legacy single-object config migrates to an active profile on boot', async ({ page }) => {
    // Seed the LEGACY config shape (what pre-T31 brains have).
    await page.addInitScript(() => {
      localStorage.setItem('sql-agent-config', JSON.stringify({
        provider: 'gemini', apiKey: 'LEGACY-KEY', model: 'gemini-2.5-flash', isConfigured: true,
      }));
    });
    await bootPage(page);

    const store = await readStore(page);
    expect(store).toBeTruthy();
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0].apiKey).toBe('LEGACY-KEY');
    expect(store.profiles[0].provider).toBe('gemini');
    expect(store.activeId).toBe(store.profiles[0].id);
    // The legacy key is gone (one-way migration).
    const legacyGone = await page.evaluate((k) => localStorage.getItem(k) === null, LEGACY_KEY);
    expect(legacyGone).toBe(true);
  });
});

test.describe('T31 — cartridge invariant', () => {
  test('a saved API key is in localStorage but never in the brain (IDB)', async ({ page }) => {
    const KEY = 'CARTRIDGE-INVARIANT-KEY-' + Date.now().toString(36);
    await bootPage(page);

    await page.click('#btn-toggle-config');
    await page.fill('#config-profile-name', 'Inv');
    await page.selectOption('#config-provider', 'gemini');
    await page.fill('#config-model', 'gemini-2.5-flash');
    await page.fill('#config-key', KEY);
    await page.click('#config-apply');
    await waitAgent(page);

    // The key IS persisted (in the profile store)…
    const inLs = await page.evaluate(
      (k) => (localStorage.getItem('sql-agent-providers') || '').includes(k),
      KEY,
    );
    expect(inLs).toBe(true);
    // …but it is NOT in the brain's IDB blocks — so a VACUUM INTO cartridge
    // export cannot leak it.
    const dump = await idbDump(page, KEY);
    expect(dump.markerFound).toBe(null);
  });
});
