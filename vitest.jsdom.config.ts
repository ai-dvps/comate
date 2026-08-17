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
      'src/client/stores/scheduled-task-store.test.ts',
      'src/client/stores/backend-store.test.ts',
      'src/client/stores/bot-store.test.ts',
      'src/client/stores/git-changes-store.test.ts',
      'src/client/stores/context-tab-store.test.ts',
      'src/client/stores/provider-usage-store.test.ts',
      'src/client/stores/skills-store.test.ts',
      'src/client/stores/expert-packages-store.test.ts',
      'src/client/stores/enterprise-zone-store.test.ts',
      'src/client/lib/bot-filter.test.ts',
      'src/client/lib/format-message-timestamp.test.ts',
      'src/client/lib/font-size.test.ts',
      'src/client/lib/workflow-utils.test.ts',
      'src/client/lib/structured-report.test.ts',
      'src/client/lib/open-url.test.ts',
      'src/client/lib/desktop-api.test.ts',
      'src/client/lib/detached-browser-api.test.ts',
      'src/client/lib/browser-view-bridge.test.ts',
      'src/client/lib/result-focus-view.test.ts',
      'src/client/lib/conversation-view.test.ts',
      'src/client/lib/prompt-references.test.ts',
      'src/client/lib/prompt-reference-state.test.ts',
      'src/client/lib/image-input.test.ts',
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
