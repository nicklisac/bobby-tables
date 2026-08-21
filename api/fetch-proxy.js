// T34 — Same-origin fetch proxy for the `fetch_url` UDF.
//
// WHY: the browser cannot read cross-origin responses without the target
// site's CORS headers (which we don't control). In dev, the Vite middleware
// in vite.config.js plays this role; in production (Vercel) this function
// does — same origin, same contract:
//
//   GET /api/fetch-proxy?url=<encoded target>  ->  target body + status
//
// The app's fetch_url UDF calls it as tier 1 (relative path), so a deploy at
// this path on the app's origin makes webfetch work with zero app changes.
//
// PRIVACY (by design): this function logs NOTHING — no URLs, no targets,
// no IPs. Fetched URLs touch exactly two parties: the target site and this
// host's operator.
//
// ABUSE: same-site only (Origin/Referer gate) + per-IP rate limit +
// upstream timeout + response size cap. Not an open relay.
//
// SSRF: the client-side blocklist in harness.js is bypassable (decimal/hex
// IPs, DNS rebinding), so the authoritative gate is HERE — we resolve DNS
// and reject loopback / private / link-local / reserved / cloud-metadata
// addresses before fetching. Residual risk: a DNS-rebinding TOCTOU window
// between resolve and fetch; Vercel's own network blocks cloud metadata
// from functions, which bounds the blast radius.
//
// RUNTIME: Node (required — `node:dns` is not available in the Edge runtime).

import { lookup } from 'node:dns/promises';

const APP_ORIGIN = 'https://tables.nicholaslisac.com';
const UPSTREAM_TIMEOUT_MS = 8_000; // < function maxDuration (20s in vercel.json)
const MAX_BODY_BYTES = 5_000_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // per IP per window (per function instance)

/**
 * True for addresses that must never be fetched: loopback, private,
 * link-local (incl. 169.254.169.254 cloud metadata), CGNAT, multicast,
 * reserved, unspecified. Malformed input is blocked (fail closed).
 */
export function isBlockedIp(ip) {
  if (typeof ip !== 'string' || !ip) return true;

  // ---- IPv4 ----
  if (!ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length !== 4) return true;
    const nums = parts.map((p) => (p === '' ? NaN : Number(p)));
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = nums;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }

  // ---- IPv6 ----
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true; // unspecified / loopback
  if (v6.startsWith('::ffff:')) {
    // IPv4-mapped/compatible (::ffff:127.0.0.1) — judge the embedded v4.
    const embedded = v6.slice('::ffff:'.length);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(embedded)) return isBlockedIp(embedded);
    return true; // hex-form mapped we can't parse: fail closed
  }
  const firstHextet = v6.split(':')[0];
  if (/^f[cd]/.test(firstHextet)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(firstHextet)) return true; // fe80::/10 link-local
  if (firstHextet === '64' && v6.startsWith('64:ff9b')) return true; // NAT64 well-known
  return false;
}

// Per-IP in-memory token bucket. Vercel runs multiple function instances, so
// this is a per-instance baseline (30/min/instance), not a global guarantee —
// the Origin gate is the primary anti-abuse control.
const buckets = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > RATE_LIMIT_WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  b.count += 1;
  if (buckets.size > 10_000) buckets.clear(); // safety valve
  return b.count <= RATE_LIMIT_MAX;
}

/**
 * X-Fetch-Proxy-Error marks the proxy's OWN failures (policy or upstream).
 * A relayed target response never carries it (upstream headers are not
 * passed through), so the app can tell "the proxy refused" from "the target
 * answered". 4xx = policy (authoritative), 5xx = upstream unreachable
 * (the app may fall through to a direct browser fetch).
 */
function send(res, status, body, extraHeaders = {}, proxyError = null) {
  res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  if (proxyError) res.setHeader('X-Fetch-Proxy-Error', proxyError);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.statusCode = status;
  res.end(body);
}

export default async function handler(req, res) {
  // NOTE: no console.* anywhere in this file — privacy by design.

  if (req.method !== 'GET') return send(res, 405, 'Method not allowed', {}, 'method-not-allowed');

  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad request', {}, 'bad-request');
  }
  if (u.pathname !== '/api/fetch-proxy') return send(res, 404, 'Not found', {}, 'not-found');

  // 1. Same-site only: only the app's own origin may use the proxy.
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const fromApp = origin === APP_ORIGIN || referer.startsWith(APP_ORIGIN + '/');
  if (!fromApp) return send(res, 403, 'Forbidden', {}, 'forbidden');

  // 2. Rate limit per client IP.
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (!rateLimitOk(ip)) return send(res, 429, 'Rate limited', {}, 'rate-limited');

  // 3. Validate the target.
  const target = u.searchParams.get('url');
  let t;
  try {
    t = new URL(target);
  } catch {
    return send(res, 400, 'Missing or invalid url parameter', {}, 'bad-target');
  }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    return send(res, 400, 'Only http(s) targets allowed', {}, 'bad-target');
  }

  // 4. SSRF gate: resolve DNS, reject blocked addresses (fail closed).
  let addrs;
  try {
    const records = await lookup(t.hostname, { all: true, verbatim: true });
    addrs = records.map((r) => r.address);
  } catch {
    return send(res, 403, 'Host does not resolve', {}, 'unresolvable-host');
  }
  if (addrs.length === 0 || addrs.some(isBlockedIp)) {
    return send(res, 403, 'Blocked host', {}, 'blocked-host');
  }

  // 5. Fetch upstream with timeout + size cap.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(t.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const body = buf.subarray(0, MAX_BODY_BYTES).toString('utf8');
    return send(
      res,
      upstream.status,
      body,
      { 'Content-Type': upstream.headers.get('content-type') || 'text/html; charset=utf-8' },
    );
  } catch {
    return send(res, 502, 'Upstream fetch failed', {}, 'upstream-failed');
  } finally {
    clearTimeout(timer);
  }
}
