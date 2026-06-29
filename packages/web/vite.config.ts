import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { DEFAULT_DAEMON_PORT } from '@thaloslab/shared';

// Dev: Vite serves the SPA on 5173 and proxies API + WS to the daemon on its fixed default port
// (the daemon must hold DEFAULT_DAEMON_PORT in dev so the proxy target is stable). Prod: the built
// SPA is copied into the daemon bundle and served by @fastify/static.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${DEFAULT_DAEMON_PORT}`, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
  // Don't pre-bundle the workspace package — let Vite watch its dist so shared changes (rebuilt
  // live by `tsc -b --watch` in `pnpm dev`) propagate to the web dev server without a restart.
  optimizeDeps: { exclude: ['@thaloslab/shared'] },
});
