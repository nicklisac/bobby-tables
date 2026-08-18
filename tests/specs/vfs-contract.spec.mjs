// Ticket 26.1 — VFS write-pattern contract suite.
//
// Asserts the contract at the VFS boundary: after any canonical write
// pattern commits, the committed page is actually in IndexedDB (at the
// committed metadata version, with no pendingVersion left behind). This is
// what catches no-op commits and seal-timing regressions — the BUG-008
// class — at the layer where they happen.
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('VFS write-pattern contract (real IDBBatchAtomicVFS)', () => {
  test('every canonical write pattern commits its page to IDB', async ({ context, page }) => {
    page.on('console', (msg) => console.log(`[PAGE ${msg.type()}]:`, msg.text()));
    page.on('pageerror', (err) => console.error(`[PAGE ERROR]:`, err));
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const mod = await import(`/tests/probes/vfs-contract-probe.mjs?t=${Date.now()}`);
      return mod.runVfsContractProbe();
    });

    expect(result.fatal, `probe fatal: ${result.fatal}`).toBeUndefined();
    for (const [name, r] of Object.entries(result.patterns)) {
      expect(r.fatal, `${name}: ${r.fatal}`).toBeUndefined();
      expect(r.inIdb, `${name}: commit must write the page to IDB (marker '${r.marker}')`).toBe(true);
      expect(
        r.atCommittedVersion,
        `${name}: marker block (v${r.block?.version}) must be at the committed metadata version (v${r.metaVersion})`,
      ).toBe(true);
      expect(r.noPendingVersion, `${name}: no pendingVersion may be left behind`).toBe(true);
    }
    expect(result.integrity, 'integrity_check after all patterns').toBe('ok');
    expect(result.ok).toBe(true);
  });
});
