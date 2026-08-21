import { defineConfig } from 'vite';

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
export default defineConfig({
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
  ],
  // Treat .wasm files as assets so Vite serves them correctly
  assetsInclude: ['**/*.wasm'],
});
