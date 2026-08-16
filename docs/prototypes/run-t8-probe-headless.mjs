import { chromium } from 'playwright';
import { createServer } from 'vite';

import os from 'os';
import path from 'path';

async function main() {
  const url = 'http://localhost:5174';
  console.log(`Connecting to dev server at ${url}...`);

  console.log('Launching system browser with JSPI enabled (--js-flags=--experimental-wasm-jspi)...');
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--js-flags=--experimental-wasm-jspi'],
    });
  } catch {
    browser = await chromium.launch({
      headless: true,
      channel: 'msedge',
      args: ['--js-flags=--experimental-wasm-jspi'],
    });
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => console.log(`[Browser Console ${msg.type()}]:`, msg.text()));
  page.on('pageerror', err => console.error('[Browser Page Error]:', err));

  console.log(`Navigating to ${url}...`);
  await page.goto(url);

  console.log('Waiting for window.__agent to initialize...');
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db), { timeout: 30000 });
  console.log('✓ Agent initialized!');

  console.log('Running Ticket 8 Probe inside the live browser runtime...');
  const result = await page.evaluate(async () => {
    const mod = await import(`/docs/prototypes/ticket-8-explorer-probe.mjs?t=${Date.now()}`);
    return await mod.runT8Probe();
  });

  console.log('\n========================================');
  console.log('PROBE RESULT:', JSON.stringify(result, null, 2));
  console.log('========================================\n');

  await browser.close();

  if (!result || !result.ok) {
    console.error('❌ Ticket 8 probe FAILED');
    process.exit(1);
  } else {
    console.log('✅ Ticket 8 probe PASSED!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal probe runner error:', err);
  process.exit(1);
});
