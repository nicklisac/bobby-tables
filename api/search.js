// T35 — Same-origin web-search proxy for the `search_web` UDF.
// Sibling of api/fetch-proxy.js (T34): same origin, same gating pattern.
//
// WHY: search_web used the DuckDuckGo Instant Answer API, which is a
// deprecated stub — verified 2026-08-21, it returns empty results for
// EVERY query (meta.id = "just_another_test"), so the agent's "web search"
// silently returned zero hits. Real search needs a server-side API call:
// keys can't live in the client, and search engines don't send CORS
// headers (html.duckduckgo.com also bot-challenges datacenter IPs).
//
//   GET /api/search?q=<query>  ->  { query, provider, results: [{title,url,snippet}] }
//
// Providers (server-side keys, never exposed to the client). Auto-priority
// when several keys are set: Exa > Tavily > Brave.
//   EXA_API_KEY     — Exa (paid plan; neural search, best for agents)
//   TAVILY_API_KEY  — Tavily (free 1,000 searches/month, no card)
//   BRAVE_API_KEY   — Brave (free $5 credits/month ≈ 1,000 searches, card req.)
//   SEARCH_PROVIDER — force 'exa', 'tavily', or 'brave'
// No key -> 503 'no-provider' (the app surfaces a clear "configure a search
// provider" error instead of silent empties).
//
// PRIVACY (by design): this function logs NOTHING. Queries touch the app's
// origin, this host, and the search provider (unavoidable — it's the
// search engine).
//
// ABUSE: same-site only (Origin/Referer gate) + per-IP rate limit
// (10/min — search is pricier than fetch) + upstream timeout.
//
// RUNTIME: Node (default for Vercel functions).

import { searchWeb, PROVIDERS } from './search-providers.mjs';

const APP_ORIGIN = 'https://tables.nicholaslisac.com';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10; // per IP per window (per function instance)

// Per-IP in-memory token bucket. Vercel runs multiple function instances, so
// this is a per-instance baseline — the Origin gate is the primary
// anti-abuse control (same as fetch-proxy).
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
 * X-Search-Error marks the proxy's OWN failures. 4xx = policy
 * (authoritative — the app surfaces it), 5xx = no provider / upstream
 * failure (the app reports search unavailable).
 */
function send(res, status, obj, proxyError = null) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  if (proxyError) res.setHeader('X-Search-Error', proxyError);
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  // NOTE: no console.* anywhere in this file — privacy by design.

  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' }, 'method-not-allowed');

  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { error: 'Bad request' }, 'bad-request');
  }
  if (u.pathname !== '/api/search') return send(res, 404, { error: 'Not found' }, 'not-found');

  // 1. Same-site only: only the app's own origin may search through us.
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const fromApp = origin === APP_ORIGIN || referer.startsWith(APP_ORIGIN + '/');
  if (!fromApp) return send(res, 403, { error: 'Forbidden' }, 'forbidden');

  // 2. Rate limit per client IP.
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (!rateLimitOk(ip)) return send(res, 429, { error: 'Rate limited' }, 'rate-limited');

  // 3. Validate the query.
  const query = (u.searchParams.get('q') || '').trim();
  if (!query) return send(res, 400, { error: 'Missing q parameter' }, 'bad-query');
  if (query.length > 400) return send(res, 400, { error: 'Query too long (max 400 chars)' }, 'bad-query');

  // 4. Search upstream.
  //    T35b (BYOK): the browser may send X-Search-Provider + X-Search-Key —
  //    the USER's own key from their config modal. When present they WIN over
  //    any host env key: each user brings their own key, so the host operator
  //    never has to (or should) share theirs. The key is used in-memory for
  //    this request only — never logged, never stored.
  //    No per-request key -> fall back to host env keys (optional default).
  const reqProvider = String(req.headers['x-search-provider'] || '').toLowerCase();
  const reqKey = String(req.headers['x-search-key'] || '').trim();
  let keys;
  if (reqKey && PROVIDERS.includes(reqProvider)) {
    keys = { [reqProvider + 'Key']: reqKey, provider: reqProvider };
  } else {
    keys = {
      exaKey: process.env.EXA_API_KEY,
      tavilyKey: process.env.TAVILY_API_KEY,
      braveKey: process.env.BRAVE_API_KEY,
      provider: process.env.SEARCH_PROVIDER,
    };
  }
  try {
    const { provider, results } = await searchWeb(query, keys);
    return send(res, 200, { query, provider, results });
  } catch (e) {
    const status = e.status === 503 ? 503 : e.status === 429 ? 429 : 502;
    const tag = status === 503 ? 'no-provider' : status === 429 ? 'provider-rate-limited' : 'upstream-failed';
    return send(res, status, { error: e.message }, tag);
  }
}
