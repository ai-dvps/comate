import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
      '@server': path.resolve(__dirname, './src/server'),
    },
  },
  test: {
    name: 'jsdom',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/client/{components,hooks}/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      'src/client/lib/**',
      'src/client/**/*.browser.test.tsx',
      'node_modules',
      'dist',
    ],
  },
})
