// Ticket 26.1 — Guardrails harness configuration.
//
// The app runs SQLite WASM with JSPI, which requires a JSPI-capable browser
// (system Chrome/Edge with --js-flags=--experimental-wasm-jspi). Bundled
// Chromium in this Playwright version cannot run JSPI, so we launch the
// system browser via `channel` — the same pattern as the existing
// docs/prototypes/*-headless.mjs probes.
//
// Each test gets a FRESH browser context = a fresh IndexedDB = a fresh
// agent brain. That is what makes the persistence assertions meaningful
// (no cross-test state) and what reproduces the "fresh-boot layout" the
// BUG-008 no-op commit depended on.
import { defineConfig } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Find a JSPI-capable system browser. Returns Playwright launchOptions
 * fragments: { channel } for branded browsers, { executablePath } for a
 * bare chromium binary.
 */
function detectBrowser() {
  if (process.env.T261_CHANNEL) return { channel: process.env.T261_CHANNEL };
  const candidates = [
    ['google-chrome --version', { channel: 'chrome' }],
    ['google-chrome-stable --version', { channel: 'chrome' }],
    ['msedge --version', { channel: 'msedge' }],
  ];
  for (const [cmd, opts] of candidates) {
    try {
      execSync(cmd, { stdio: 'ignore' });
      return opts;
    } catch {
      // try the next candidate
    }
  }
  try {
    const bin = execSync('command -v chromium || command -v chromium-browser', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (bin) return { executablePath: bin };
  } catch {
    // no bare chromium either
  }
  throw new Error(
    'No system browser found for the guardrails harness. It needs Chrome or Edge ' +
      '(JSPI: --js-flags=--experimental-wasm-jspi). Set T261_CHANNEL to override.',
  );
}

export default defineConfig({
  testDir: './tests/specs',
  // Boot + reload + turn can take a while on a cold machine.
  // Tests must be snappy (passing runs are sub-5s). 30s is a hard ceiling:
  // anything slower is either a deadlock (BUG-008) or a real perf regression.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // One browser, one tab at a time: the dev server is shared and the app is
  // single-connection by design.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5174',
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      ...detectBrowser(),
      args: ['--js-flags=--experimental-wasm-jspi'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5174',
    // Reuse the user's already-running dev server when present (the preview
    // browser's tab). Tests use their own fresh context, so there is no
    // state sharing either way.
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
