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
  // Treat .wasm files as assets so Vite serves them correctly
  assetsInclude: ['**/*.wasm'],
});
