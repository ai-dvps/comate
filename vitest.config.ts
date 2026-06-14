/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Vitest runs React component tests + hooks that need jsdom. Existing
    // client tests under src/client/lib use node:test (no DOM needed) and
    // are excluded here to avoid the "No test suite found" error from
    // vitest trying to parse their node:test-shaped imports.
    include: ['src/client/{components,hooks}/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['src/client/lib/**', 'node_modules', 'dist'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
