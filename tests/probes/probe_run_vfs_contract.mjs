import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[PAGE ${msg.type()}]:`, msg.text()));
  page.on('pageerror', (err) => console.error(`[PAGE ERROR]:`, err));

  console.log('=== Booting page ===');
  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready));
  console.log('Booted!');

  console.log('=== Running vfs-contract-probe ===');
  const result = await page.evaluate(async () => {
    const mod = await import(`/tests/probes/vfs-contract-probe.mjs?t=${Date.now()}`);
    return mod.runVfsContractProbe();
  });

  console.log('Result:', JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch(console.error);
