// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

const DEV_PORT = 5273;
/** Must match DEFAULT_PORT in packages/shared/src/settings.ts. */
const BACKEND_PORT = 8084;

export default defineConfig({
  plugins: [
    vue(),
    // Tree-shakes Vuetify to the components actually used; the full library is ~1 MB of CSS.
    vuetify({ autoImport: true }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // Same-origin in production, so the dev server proxies rather than enabling CORS —
    // otherwise dev would need a CORS policy the shipped app must never have.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: false,
        // SSE must not be buffered, or every progress update arrives at once when the
        // job finishes.
        ws: false,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Source maps ship: this is AGPL software that users are entitled to inspect, and it
    // makes a bug report from a real install actionable.
    sourcemap: true,
  },
});
