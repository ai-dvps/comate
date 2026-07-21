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
    include: [
      'src/client/{components,hooks}/**/*.{test,spec}.{ts,tsx}',
      'src/client/stores/chat-store.test.ts',
      'src/client/stores/bot-store.test.ts',
      'src/client/stores/git-changes-store.test.ts',
      'src/client/stores/right-panel-store.test.ts',
      'src/client/lib/bot-filter.test.ts',
      'src/client/lib/format-message-timestamp.test.ts',
      'src/client/lib/font-size.test.ts',
      'src/client/lib/workflow-utils.test.ts',
      'src/client/lib/structured-report.test.ts',
      'src/client/lib/open-url.test.ts',
      'src/client/lib/result-focus-view.test.ts',
    ],
    exclude: [
      'src/client/lib/keyboard.test.ts',
      'src/client/lib/session-filter.test.ts',
      'src/client/lib/session-sort.test.ts',
      'src/client/lib/sound-player.test.ts',
      'src/client/lib/summarize-tool-input.test.ts',
      'src/client/lib/updater-api.test.ts',
      'src/client/lib/updater-config.test.ts',
      'src/client/lib/use-badge-sync.test.ts',
      'src/client/**/*.browser.test.tsx',
      'node_modules',
      'dist',
    ],
  },
})
