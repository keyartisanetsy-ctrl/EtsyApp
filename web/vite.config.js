import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Set at build time when this app is served under a URL prefix behind a
// reverse proxy (e.g. "/etsy-shopify" on a shared hub domain). Empty by
// default, so a plain build still serves from the root exactly as before.
const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '');

export default defineConfig({
  plugins: [react()],
  base: `${basePath}/`,
  server: {
    port: 5317,
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1200 },
});
