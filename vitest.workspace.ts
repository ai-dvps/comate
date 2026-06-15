/// <reference types="vitest" />
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'jsdom',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
      // Vitest runs React component tests + hooks that need jsdom. Existing
      // client tests under src/client/lib use node:test (no DOM needed) and
      // are excluded here to avoid the "No test suite found" error from
      // vitest trying to parse their node:test-shaped imports.
      include: ['src/client/{components,hooks}/**/*.{test,spec}.{ts,tsx}'],
      exclude: [
        'src/client/lib/**',
        'src/client/**/*.browser.test.tsx',
        'node_modules',
        'dist',
      ],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'browser',
      browser: {
        provider: 'playwright',
        name: 'chromium',
        headless: true,
        enabled: true,
      },
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/client/**/*.browser.test.tsx'],
      exclude: ['node_modules', 'dist'],
    },
  },
]);
