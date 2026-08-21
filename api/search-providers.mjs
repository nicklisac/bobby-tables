// T35 — Server-side search providers (Exa + Tavily + Brave), shared by the
// Vercel function (api/search.js) and the Vite dev middleware
// (vite.config.js) so both environments normalize results identically.
//
// WHY SERVER-SIDE: search engines don't send CORS headers, and API keys can't
// live in the browser. The old client-side DuckDuckGo Instant Answer endpoint
// was a deprecated stub (BUG-023: empty for every query).
//
// PROVIDERS (contracts verified 2026-08-21):
//   Exa     POST https://api.exa.ai/search
//           x-api-key auth. type=auto, contents={highlights,text}. 402 =
//           credits exhausted (paid plan). Highest quality for agents.
//   Tavily  POST https://api.tavily.com/search
//           Bearer auth. basic depth = 1 credit. Free: 1,000 credits/month,
//           NO credit card, resets on the 1st. 432/433 = quota exhausted.
//   Brave   GET https://api.search.brave.com/res/v1/web/search
//           X-Subscription-Token auth. $5/1,000 requests with $5 free credits
//           monthly (≈1,000 searches) — credit card required to sign up.
//
// Selection (searchWeb): explicit `provider` wins; otherwise the first key
// present in priority order Exa > Tavily > Brave. Pure Node, zero deps.

const EXA_ENDPOINT = 'https://api.exa.ai/search';
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const TIMEOUT_MS = 10_000;

function withStatus(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Normalize an Exa response to [{ title, url, snippet }]. */
export function normalizeExaResults(data) {
  const out = [];
  const results = data?.results;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r && typeof r === 'object' && r.url && r.title) {
        const highlights = Array.isArray(r.highlights)
          ? r.highlights.filter((h) => h && String(h).trim())
          : [];
        const snippet = (highlights.length ? highlights.join(' … ') : String(r.text || '')).slice(0, 400);
        out.push({
          title: String(r.title).slice(0, 200),
          url: String(r.url),
          snippet,
        });
      }
    }
  }
  return out;
}

/** Normalize a Tavily response to [{ title, url, snippet }]. */
export function normalizeTavilyResults(data) {
  const out = [];
  const results = data?.results;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r && typeof r === 'object' && r.url && r.title) {
        out.push({
          title: String(r.title).slice(0, 200),
          url: String(r.url),
          snippet: String(r.content || '').slice(0, 400),
        });
      }
    }
  }
  return out;
}

/** Normalize a Brave web-search response to [{ title, url, snippet }]. */
export function normalizeBraveResults(data) {
  const out = [];
  const results = data?.web?.results;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r && typeof r === 'object' && r.url && r.title) {
        out.push({
          title: String(r.title).slice(0, 200),
          url: String(r.url),
          snippet: String(r.description || '').slice(0, 400),
        });
      }
    }
  }
  return out;
}

/**
 * Run an Exa search (type=auto; highlights + capped text for the snippet).
 * @throws {Error & {status}} 429 (rate limit / credits exhausted), 502 (bad key / upstream).
 */
export async function exaSearch(query, apiKey, { count = 10 } = {}) {
  const n = Math.min(Math.max(Math.trunc(count) || 10, 1), 100);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(EXA_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: n,
        contents: { highlights: true, text: { maxCharacters: 600 } },
      }),
    });
    if (resp.status === 402) throw withStatus('search provider credits exhausted (top up your Exa plan)', 429);
    if (resp.status === 429) throw withStatus('search provider rate limit', 429);
    if (resp.status === 401 || resp.status === 403) throw withStatus('search provider rejected the API key', 502);
    if (!resp.ok) throw withStatus(`search provider HTTP ${resp.status}`, 502);
    const data = await resp.json();
    return { provider: 'exa', results: normalizeExaResults(data) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a Tavily search (basic depth = 1 credit).
 * @throws {Error & {status}} 429 (rate limit / quota), 502 (bad key / upstream).
 */
export async function tavilySearch(query, apiKey, { count = 10 } = {}) {
  const n = Math.min(Math.max(Math.trunc(count) || 10, 1), 20);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: n }),
    });
    if (resp.status === 429) throw withStatus('search provider rate limit', 429);
    if (resp.status === 432 || resp.status === 433) {
      throw withStatus('search provider quota exhausted (free tier resets on the 1st of the month)', 429);
    }
    if (resp.status === 401 || resp.status === 403) throw withStatus('search provider rejected the API key', 502);
    if (!resp.ok) throw withStatus(`search provider HTTP ${resp.status}`, 502);
    const data = await resp.json();
    return { provider: 'tavily', results: normalizeTavilyResults(data) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a Brave web search.
 * @throws {Error & {status}} 429 (rate limit), 502 (bad key / upstream).
 */
export async function braveSearch(query, apiKey, { count = 10 } = {}) {
  const n = Math.min(Math.max(Math.trunc(count) || 10, 1), 20);
  const url =
    `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}` +
    `&count=${n}&safesearch=moderate`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (resp.status === 429) throw withStatus('search provider rate limit', 429);
    if (resp.status === 401 || resp.status === 403) throw withStatus('search provider rejected the API key', 502);
    if (!resp.ok) throw withStatus(`search provider HTTP ${resp.status}`, 502);
    const data = await resp.json();
    return { provider: 'brave', results: normalizeBraveResults(data) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider-agnostic dispatch.
 *
 * @param {string} query
 * @param {{exaKey?: string, tavilyKey?: string, braveKey?: string, provider?: string}} keys
 * @param {{count?: number}} [opts]
 * @returns {Promise<{provider: 'exa'|'tavily'|'brave', results: Array<{title,url,snippet}>}>}
 * @throws {Error & {status}} 503 (no provider configured), 429, 502.
 */
export async function searchWeb(query, { exaKey, tavilyKey, braveKey, provider } = {}, opts = {}) {
  let name = provider;
  if (!name) name = exaKey ? 'exa' : tavilyKey ? 'tavily' : braveKey ? 'brave' : null;
  if (!name) {
    throw withStatus(
      'No search provider configured (set EXA_API_KEY, or TAVILY_API_KEY — free 1,000 searches/month, no card — or BRAVE_API_KEY on the host)',
      503,
    );
  }
  if (name === 'exa') {
    if (!exaKey) throw withStatus('SEARCH_PROVIDER=exa but EXA_API_KEY is not set', 503);
    return exaSearch(query, exaKey, opts);
  }
  if (name === 'brave') {
    if (!braveKey) throw withStatus('SEARCH_PROVIDER=brave but BRAVE_API_KEY is not set', 503);
    return braveSearch(query, braveKey, opts);
  }
  if (!tavilyKey) throw withStatus('SEARCH_PROVIDER=tavily but TAVILY_API_KEY is not set', 503);
  return tavilySearch(query, tavilyKey, opts);
}
