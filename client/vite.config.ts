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
