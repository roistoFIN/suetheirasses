import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@suetheirasses/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  // `vite preview` (used by CI's E2E job — tests/playwright.config.ts's webServer runs
  // `npm run preview:client` when CI is set) does NOT inherit `server.port`; without its
  // own `preview.port` it falls back to Vite's default of 4173, while Playwright's
  // webServer.url is hardcoded to :5173 for both dev and preview — a real, reproduced
  // bug where the E2E job's server started fine but Playwright waited 60s for the wrong
  // port and timed out. Keep this in sync with server.port below.
  preview: {
    port: 5173,
    host: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
    // Native OS file-change events (inotify) have proven unreliable for this dev
    // setup — HMR would silently stop picking up edits (including to
    // ../shared/src, outside this package's own root) after the dev server had
    // been running a while, requiring a manual restart to see any further change.
    // Polling doesn't depend on inotify at all, trading a small CPU cost for not
    // going stale. Keep this if you ever revisit dev server config here.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
});
