import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [preact()],
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0, // CSP: no data: fonts or scripts
    modulePreload: { polyfill: false },
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
