import { defineConfig, loadEnv } from 'vite';
import { searchWeb } from './api/search-providers.mjs';

/**
 * Vite configuration for the Web SQL Agent.
 *
 * CRITICAL: COOP/COEP headers are required for SharedArrayBuffer,
 * which OPFS (Origin Private File System) depends on. Without these
 * headers, SharedArrayBuffer is undefined and OPFS won't work.
 *
 * For production deployment, your web server MUST also serve these headers:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 */
export default defineConfig(({ mode }) => {
  // T35: load .env / .env.local for the dev search proxy (BRAVE_API_KEY).
  // loadEnv with an empty prefix loads ALL vars, not just VITE_-prefixed ones.
  const env = loadEnv(mode, process.cwd(), '');

  return {
  server: {
    port: 5174,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [
    {
      name: 'fetch-proxy-plugin',
      configureServer(server) {
        server.middlewares.use('/api/fetch-proxy', async (req, res) => {
          try {
            const urlObj = new URL(req.url, 'http://localhost:5174');
            const targetUrl = urlObj.searchParams.get('url');
            if (!targetUrl) {
              res.statusCode = 400;
              // T34 contract: mark the proxy's OWN errors so the app can tell
              // them apart from relayed target responses (see api/fetch-proxy.js).
              res.setHeader('X-Fetch-Proxy-Error', 'bad-target');
              res.end('Missing url parameter');
              return;
            }
            const fetchResp = await fetch(targetUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              },
            });
            const text = await fetchResp.text();
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.statusCode = fetchResp.status;
            res.end(text);
          } catch (err) {
            // 5xx = upstream unreachable (DNS failure, timeout, …). The app
            // falls through to a direct browser fetch for these — the browser
            // may have reach the dev server lacks (T28 route-intercepted hosts).
            res.statusCode = 500;
            res.setHeader('X-Fetch-Proxy-Error', 'upstream-failed');
            res.end(err.message);
          }
        });
      },
    },
    {
      // T35 — dev parity for api/search.js (the Vercel function). Same
      // contract: GET /api/search?q=... -> { query, provider, results } or
      // 503 { error } when no key is configured. The key comes from
      // process.env or .env / .env.local (BRAVE_API_KEY) — never the client.
      name: 'search-proxy-plugin',
      configureServer(server) {
        server.middlewares.use('/api/search', async (req, res) => {
          const json = (status, obj, searchError) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (searchError) res.setHeader('X-Search-Error', searchError);
            res.end(JSON.stringify(obj));
          };
          try {
            const u = new URL(req.url, 'http://localhost:5174');
            const query = (u.searchParams.get('q') || '').trim();
            if (!query) return json(400, { error: 'Missing q parameter' }, 'bad-query');
            if (query.length > 400) return json(400, { error: 'Query too long (max 400 chars)' }, 'bad-query');
            const { provider, results } = await searchWeb(query, {
              exaKey: process.env.EXA_API_KEY || env.EXA_API_KEY,
              tavilyKey: process.env.TAVILY_API_KEY || env.TAVILY_API_KEY,
              braveKey: process.env.BRAVE_API_KEY || env.BRAVE_API_KEY,
              provider: process.env.SEARCH_PROVIDER || env.SEARCH_PROVIDER,
            });
            return json(200, { query, provider, results });
          } catch (e) {
            const status = e.status === 503 ? 503 : e.status === 429 ? 429 : 502;
            const tag = status === 503 ? 'no-provider' : status === 429 ? 'provider-rate-limited' : 'upstream-failed';
            return json(status, { error: e.message }, tag);
          }
        });
      },
    },
  ],
  // Treat .wasm files as assets so Vite serves them correctly
  assetsInclude: ['**/*.wasm'],
  };
});
