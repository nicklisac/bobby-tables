// T34 — Same-origin fetch proxy (BUG-022): webfetch is dead on hosted
// deployments and the old fallback leaked every fetched URL to third-party
// CORS proxies.
//
// Guards:
//   1. isBlockedIp — the SSRF address gate (loopback/private/link-local/
//      metadata/reserved, IPv4 + IPv6 + IPv4-mapped, fail closed).
//   2. The Vercel handler's policy layer — method/path/origin/rate-limit/
//      target validation/SSRF blocks (no external network needed).
//   3. Live passthrough — the handler fetches a real public page and
//      returns body + status (skipped when offline).
//   4. Dev-proxy e2e contract — the app's tier-1 relative call
//      (/api/fetch-proxy?url=…) works against the Vite middleware, i.e. the
//      dev and prod proxies are interchangeable.
//   5. Privacy regression guard — no third-party CORS proxy remains in the
//      fetch_url UDF source.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import handler, { isBlockedIp } from '../../api/fetch-proxy.js';

const APP_ORIGIN = 'https://tables.nicholaslisac.com';

// ---- isBlockedIp: the SSRF gate ------------------------------------------

test.describe('T34 — isBlockedIp', () => {
  test('blocks loopback / private / link-local / metadata / reserved', () => {
    for (const ip of [
      '127.0.0.1', '127.5.5.5',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1', '172.31.255.255',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1', // CGNAT
      '224.0.0.1', '239.255.255.255', '255.255.255.255',
      '::1', '::',
      'fd00::1', 'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedIp(ip), `expected ${ip} to be blocked`).toBe(true);
    }
  });

  test('blocks malformed input (fail closed)', () => {
    for (const ip of ['', 'abc', '300.1.1.1', '1.2.3', '::ffff:zzzz', '1.2.3.4.5']) {
      expect(isBlockedIp(ip), `expected ${JSON.stringify(ip)} to be blocked`).toBe(true);
    }
  });

  test('allows public addresses', () => {
    for (const ip of [
      '93.184.216.34', // example.com
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1', // just outside 172.16/12
      '100.128.0.1', // just outside CGNAT
      '2606:2800:220:1:248:1893:25c8:1946',
    ]) {
      expect(isBlockedIp(ip), `expected ${ip} to be allowed`).toBe(false);
    }
  });
});

// ---- handler policy layer (no external network) ---------------------------

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
  path = '/api/fetch-proxy',
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

test.describe('T34 — handler policy', () => {
  test('404 on unknown path, 405 on non-GET', async () => {
    expect((await callHandler({ path: '/api/nope' })).statusCode).toBe(404);
    expect((await callHandler({ method: 'POST' })).statusCode).toBe(405);
  });

  test('403 without a same-site Origin/Referer (anti open-relay)', async () => {
    expect((await callHandler({ origin: null, query: 'url=https%3A%2F%2Fexample.com' })).statusCode).toBe(403);
    expect((await callHandler({ origin: 'https://evil.com', query: 'url=https%3A%2F%2Fexample.com' })).statusCode).toBe(403);
    expect((await callHandler({ origin: null, referer: 'https://evil.com/page', query: 'url=https%3A%2F%2Fexample.com' })).statusCode).toBe(403);
    // Same-site referer is accepted.
    expect((await callHandler({ origin: null, referer: APP_ORIGIN + '/chat', query: 'url=https%3A%2F%2Fexample.com' })).statusCode).not.toBe(403);
  });

  test('400 on missing / invalid / non-http(s) targets', async () => {
    expect((await callHandler({})).statusCode).toBe(400); // no url param
    expect((await callHandler({ query: 'url=not a url' })).statusCode).toBe(400);
    expect((await callHandler({ query: 'url=file%3A%2F%2F%2Fetc%2Fpasswd' })).statusCode).toBe(400);
    expect((await callHandler({ query: 'url=javascript%3Aalert(1)' })).statusCode).toBe(400);
  });

  test('403 SSRF: loopback, private, metadata, decimal-IP encodings', async () => {
    for (const target of [
      'http://localhost:5174/',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://2130706433/', // 127.0.0.1 in decimal — URL parser normalizes it
      'http://10.0.0.5/',
      'http://[::1]/',
    ]) {
      const res = await callHandler({ query: `url=${encodeURIComponent(target)}` });
      expect(res.statusCode, `expected ${target} to be blocked`).toBe(403);
    }
  });

  test('429 after exceeding the per-IP rate limit', async () => {
    const ip = '8.8.7.7'; // dedicated bucket
    let last;
    for (let i = 0; i < 31; i++) {
      last = await callHandler({ ip, query: 'url=http%3A%2F%2F127.0.0.1%2F' });
    }
    expect(last.statusCode).toBe(429);
  });

  test('sets the app origin as Access-Control-Allow-Origin', async () => {
    const res = await callHandler({ query: 'url=http%3A%2F%2F127.0.0.1%2F' });
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });

  test('marks its own errors with X-Fetch-Proxy-Error (app contract)', async () => {
    const blocked = await callHandler({ query: 'url=http%3A%2F%2F127.0.0.1%2F' });
    expect(blocked.headers['x-fetch-proxy-error']).toBe('blocked-host');
    const forbidden = await callHandler({ origin: 'https://evil.com', query: 'url=https%3A%2F%2Fexample.com' });
    expect(forbidden.headers['x-fetch-proxy-error']).toBe('forbidden');
    const badTarget = await callHandler({});
    expect(badTarget.headers['x-fetch-proxy-error']).toBe('bad-target');
  });
});

// ---- live passthrough (skipped when offline) -------------------------------

test.describe('T34 — live passthrough', () => {
  test('fetches a public page and returns body + status + content-type', async () => {
    const res = await callHandler({ query: 'url=https%3A%2F%2Fexample.com' });
    const offline = res.statusCode === 502 || (res.statusCode === 403 && /does not resolve/.test(res.body));
    if (offline) test.skip(true, 'offline — upstream DNS/fetch failed');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Example Domain');
    expect(res.headers['content-type']).toContain('text/html');
  });
});

// ---- dev-proxy e2e contract (Vite middleware) ------------------------------

test.describe('T34 — dev proxy contract (e2e)', () => {
  test('the app-origin relative call works against the Vite middleware', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const body = await page.evaluate(async () => {
      const r = await fetch(`/api/fetch-proxy?url=${encodeURIComponent('https://example.com')}`);
      return { status: r.status, text: await r.text() };
    });
    if (body.status === 500 && /fetch|network|ENOTFOUND|EAI_AGAIN/i.test(body.text)) {
      test.skip(true, 'offline — dev proxy upstream failed');
    }
    expect(body.status).toBe(200);
    expect(body.text).toContain('Example Domain');
  });

  test('dev proxy marks upstream failures 5xx + X-Fetch-Proxy-Error (fall-through case)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // A host that exists nowhere: the middleware's Node-side fetch fails DNS,
    // so it must answer 5xx WITH the error header — that is what tells the
    // app to fall through to a direct browser fetch (T28 relies on this).
    const r = await page.evaluate(async () => {
      const resp = await fetch(`/api/fetch-proxy?url=${encodeURIComponent('http://slow-t28.example/nope')}`);
      return { status: resp.status, err: resp.headers.get('x-fetch-proxy-error') };
    });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.err).toBe('upstream-failed');
  });
});

// ---- privacy regression guard ----------------------------------------------

test('T34 — no third-party CORS proxy remains in the fetch_url UDF', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../src/harness.js'), 'utf8');
  expect(src).not.toContain('corsproxy.io');
  expect(src).not.toContain('allorigins.win');
  expect(src).toContain('sql-agent-fetch-proxy');
});
