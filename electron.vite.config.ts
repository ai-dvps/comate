import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

/**
 * U1 (KTD-13): electron-vite builds the main + preload processes (both CJS —
 * the package root is `"type": "module"`, so outputs carry explicit `.cjs`
 * extensions and the sandboxed preload stays CJS as required). The renderer
 * is intentionally NOT built here: the client keeps its existing Vite config
 * (`vite.config.ts` → dist/client) until U2/U3 rewire delivery.
 *
 * Entry paths MUST be absolute via `resolve(__dirname, ...)`: a bare
 * 'electron/main.ts' specifier collides with the externalized `electron`
 * package name and rollup rejects it ("entry module cannot be external").
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: resolve(__dirname, 'electron/main.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
});
