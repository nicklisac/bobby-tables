// T35 — Same-origin web-search proxy (BUG-023): search_web used the
// DuckDuckGo Instant Answer API, a deprecated stub (verified 2026-08-21:
// empty for EVERY query, meta.id="just_another_test"), so the agent's web
// search silently returned zero results. Search now goes through the
// same-origin /api/search function (Vercel: api/search.js, dev: the vite
// middleware), which calls Brave Search server-side — the key never reaches
// the browser, no third-party proxy is involved.
//
// Guards:
//   1. The shared normalizers (Exa/Tavily/Brave fixtures, no network).
//   2. The Vercel handler's policy layer — method/path/origin/rate-limit/
//      query validation/no-provider (no external network needed).
//   3. Live search — a real query (skipped unless a provider key is set).
//   4. Dev-proxy e2e contract — the app's relative call (/api/search?q=…)
//      works against the Vite middleware, i.e. dev and prod are
//      interchangeable.
//   5. Privacy regression guard — the dead DDG stub and any third-party
//      search middleman are gone from the search_web UDF source.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import handler from '../../api/search.js';
import { normalizeExaResults, normalizeTavilyResults, normalizeBraveResults } from '../../api/search-providers.mjs';

const APP_ORIGIN = 'https://tables.nicholaslisac.com';

// ---- the shared normalizers (Exa / Tavily / Brave) -------------------------

const EXA_FIXTURE = {
  requestId: 'abc',
  results: [
    { title: 'Vite 6.0 Release Notes', url: 'https://vite.dev/v6', text: 'Full page text here.', highlights: ['Ship it faster.', 'New React plugin.'] },
    { title: 'No highlights', url: 'https://plain.example', text: 'Fallback text used when highlights are empty.' },
    { title: 'Empty everything', url: 'https://empty.example' },
    { title: '', url: 'https://skip.me' }, // empty title -> dropped
    { url: 'https://notitle.example' }, // missing title -> dropped
    null, // malformed entry -> dropped
    { title: 'X'.repeat(500), url: 'https://long.example', highlights: ['Y'.repeat(900)] },
  ],
};

const TAVILY_FIXTURE = {
  query: 'vite 6 release notes',
  results: [
    { title: 'Vite 6.0 Release Notes', url: 'https://vite.dev/v6', content: 'The big one.', score: 0.9 },
    { title: '', url: 'https://skip.me' }, // empty title -> dropped
    { url: 'https://notitle.example' }, // missing title -> dropped
    null, // malformed entry -> dropped
    { title: 'X'.repeat(500), url: 'https://long.example', content: 'Y'.repeat(900) },
  ],
};

test.describe('T35 — normalizeExaResults', () => {
  test('prefers highlights over text for the snippet', () => {
    const out = normalizeExaResults(EXA_FIXTURE);
    expect(out).toHaveLength(4);
    expect(out[0].snippet).toBe('Ship it faster. … New React plugin.');
    // No highlights -> falls back to text.
    expect(out[1].snippet).toBe('Fallback text used when highlights are empty.');
    // No highlights AND no text -> empty snippet (entry kept, url/title intact).
    expect(out[2].snippet).toBe('');
  });

  test('truncates long titles (200) and snippets (400)', () => {
    const out = normalizeExaResults(EXA_FIXTURE);
    expect(out[3].title.length).toBe(200);
    expect(out[3].snippet.length).toBe(400);
  });

  test('tolerates malformed payloads (returns [])', () => {
    expect(normalizeExaResults(null)).toEqual([]);
    expect(normalizeExaResults({})).toEqual([]);
    expect(normalizeExaResults({ results: 'nope' })).toEqual([]);
    expect(normalizeExaResults({ results: [] })).toEqual([]);
  });
});

test.describe('T35 — normalizeTavilyResults', () => {
  test('normalizes results to {title, url, snippet}', () => {
    const out = normalizeTavilyResults(TAVILY_FIXTURE);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'Vite 6.0 Release Notes', url: 'https://vite.dev/v6', snippet: 'The big one.' });
  });

  test('truncates long titles (200) and snippets (400)', () => {
    const out = normalizeTavilyResults(TAVILY_FIXTURE);
    expect(out[1].title.length).toBe(200);
    expect(out[1].snippet.length).toBe(400);
  });

  test('tolerates malformed payloads (returns [])', () => {
    expect(normalizeTavilyResults(null)).toEqual([]);
    expect(normalizeTavilyResults({})).toEqual([]);
    expect(normalizeTavilyResults({ results: 'nope' })).toEqual([]);
  });
});

const BRAVE_FIXTURE = {
  query: { original: 'vite 6 release notes', more_results_available: false },
  web: {
    results: [
      { title: 'Vite 6.0 Release Notes', url: 'https://vite.dev/v6', description: 'The big one.' },
      { title: '', url: 'https://skip.me' }, // empty title -> dropped
      { url: 'https://notitle.example' }, // missing title -> dropped
      { title: 'No URL entry' }, // missing url -> dropped
      null, // malformed entry -> dropped
      { title: 'X'.repeat(500), url: 'https://long.example', description: 'Y'.repeat(900) },
    ],
  },
};

test.describe('T35 — normalizeBraveResults', () => {
  test('normalizes web.results to {title, url, snippet}', () => {
    const out = normalizeBraveResults(BRAVE_FIXTURE);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'Vite 6.0 Release Notes', url: 'https://vite.dev/v6', snippet: 'The big one.' });
    expect(out.every((r) => r.title && r.url)).toBe(true);
  });

  test('truncates long titles (200) and snippets (400)', () => {
    const out = normalizeBraveResults(BRAVE_FIXTURE);
    expect(out[1].title.length).toBe(200);
    expect(out[1].snippet.length).toBe(400);
  });

  test('tolerates malformed payloads (returns [])', () => {
    expect(normalizeBraveResults(null)).toEqual([]);
    expect(normalizeBraveResults({})).toEqual([]);
    expect(normalizeBraveResults({ web: null })).toEqual([]);
    expect(normalizeBraveResults({ web: { results: 'nope' } })).toEqual([]);
    expect(normalizeBraveResults({ web: { results: [] } })).toEqual([]);
  });
});

// ---- handler policy layer (no external network) ----------------------------

let ipCounter = 0;
function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    end(b = '') { res.body += b; },
  };
  return res;
}

async function callHandler({
  path = '/api/search',
  query = '',
  method = 'GET',
  origin = APP_ORIGIN,
  referer = null,
  ip = null,
} = {}) {
  const clientIp = ip || `9.9.9.${++ipCounter}`; // unique per call: isolate rate-limit buckets
  const req = {
    method,
    url: path + (query ? `?${query}` : ''),
    headers: {
      ...(origin ? { origin } : {}),
      ...(referer ? { referer } : {}),
      'x-forwarded-for': clientIp,
    },
    socket: { remoteAddress: clientIp },
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

test.describe('T35 — handler policy', () => {
  test('404 on unknown path, 405 on non-GET', async () => {
    expect((await callHandler({ path: '/api/nope' })).statusCode).toBe(404);
    expect((await callHandler({ method: 'POST' })).statusCode).toBe(405);
  });

  test('403 without a same-site Origin/Referer (anti open-search-relay)', async () => {
    expect((await callHandler({ origin: null, query: 'q=hello' })).statusCode).toBe(403);
    expect((await callHandler({ origin: 'https://evil.com', query: 'q=hello' })).statusCode).toBe(403);
    expect((await callHandler({ origin: null, referer: 'https://evil.com/page', query: 'q=hello' })).statusCode).toBe(403);
    // Same-site referer is accepted (proceeds past the gate).
    const ok = await callHandler({ origin: null, referer: APP_ORIGIN + '/chat', query: 'q=hello' });
    expect(ok.statusCode).not.toBe(403);
  });

  test('400 on missing / overlong query', async () => {
    expect((await callHandler({})).statusCode).toBe(400); // no q
    expect((await callHandler({ query: 'q=%20%20' })).statusCode).toBe(400); // whitespace-only
    expect((await callHandler({ query: `q=${'a'.repeat(401)}` })).statusCode).toBe(400);
  });

  test('429 after exceeding the per-IP rate limit (10/min)', async () => {
    const ip = '8.8.7.8'; // dedicated bucket
    let last;
    for (let i = 0; i < 11; i++) {
      last = await callHandler({ ip, query: 'q=hello' });
    }
    expect(last.statusCode).toBe(429);
    expect(last.headers['x-search-error']).toBe('rate-limited');
  });

  test('503 no-provider when no provider key is set', async () => {
    const saved = {
      EXA_API_KEY: process.env.EXA_API_KEY,
      TAVILY_API_KEY: process.env.TAVILY_API_KEY,
      BRAVE_API_KEY: process.env.BRAVE_API_KEY,
      SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    };
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.SEARCH_PROVIDER;
    try {
      const res = await callHandler({ query: 'q=hello' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['x-search-error']).toBe('no-provider');
      // The error names the exact env var to set (Exa first — it's the
      // preferred provider).
      expect(JSON.parse(res.body).error).toContain('EXA_API_KEY');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('sets the app origin as Access-Control-Allow-Origin + JSON content type', async () => {
    const res = await callHandler({ query: 'q=hello' });
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['content-type']).toContain('application/json');
  });

  test('marks its own errors with X-Search-Error (app contract)', async () => {
    const forbidden = await callHandler({ origin: 'https://evil.com', query: 'q=hello' });
    expect(forbidden.headers['x-search-error']).toBe('forbidden');
    const badQuery = await callHandler({});
    expect(badQuery.headers['x-search-error']).toBe('bad-query');
  });
});

// ---- live search (skipped unless a key is configured) -----------------------

test.describe('T35 — live search', () => {
  test('queries the configured provider and returns normalized results', async () => {
    // Mirror the handler's auto-priority: Exa > Tavily > Brave.
    const expected = process.env.EXA_API_KEY ? 'exa'
      : process.env.TAVILY_API_KEY ? 'tavily'
      : process.env.BRAVE_API_KEY ? 'brave'
      : null;
    if (!expected) test.skip(true, 'no provider key set — live search skipped');
    const res = await callHandler({ query: 'q=vite+6+release+notes' });
    if (res.statusCode === 429) test.skip(true, 'provider rate limit / quota — live search skipped');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.provider).toBe(expected);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    for (const r of body.results) {
      expect(r.title).toBeTruthy();
      expect(r.url).toMatch(/^https?:\/\//);
    }
  });
});

// ---- dev-proxy e2e contract (Vite middleware) -------------------------------

test.describe('T35 — dev proxy contract (e2e)', () => {
  test('the app-origin relative call answers the contract (200 with a key, 503 without)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(async () => {
      const resp = await fetch('/api/search?q=sqlite+wasm');
      return {
        status: resp.status,
        err: resp.headers.get('x-search-error'),
        body: await resp.json().catch(() => null),
      };
    });
    if (r.status === 503) {
      // No key on this dev server: the contract says 503 + no-provider, and
      // the error names the env var to set (Exa first — preferred provider).
      expect(r.err).toBe('no-provider');
      expect(r.body.error).toContain('EXA_API_KEY');
    } else if (r.status === 200) {
      // Key present: real results in the normalized shape.
      expect(Array.isArray(r.body.results)).toBe(true);
      for (const item of r.body.results) {
        expect(item.title).toBeTruthy();
        expect(item.url).toMatch(/^https?:\/\//);
      }
    } else {
      test.fail(true, `unexpected dev-proxy status ${r.status}: ${JSON.stringify(r.body)}`);
    }
  });

  test('400 on missing q (deterministic, no key needed)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(async () => {
      const resp = await fetch('/api/search');
      return { status: resp.status, err: resp.headers.get('x-search-error') };
    });
    expect(r.status).toBe(400);
    expect(r.err).toBe('bad-query');
  });
});

// ---- privacy regression guard ------------------------------------------------

test('T35 — the dead DDG stub and third-party search middlemen are gone', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../src/harness.js'), 'utf8');
  expect(src).not.toContain('api.duckduckgo.com'); // deprecated stub (BUG-023)
  expect(src).not.toContain('corsproxy.io');
  expect(src).not.toContain('allorigins.win');
  expect(src).toContain('/api/search'); // the same-origin tier is in place
});
