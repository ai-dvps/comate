import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import os from 'os'

/**
 * U12 (KTD-28): the sidecar's /api surface is default-deny authenticated.
 * In dev, the Tauri shell is not in the loop, so this proxy injects the
 * desktop GUI credential on behalf of the local client: the sidecar writes
 * it per boot to <dataDir>/desktop-auth.json (mode 0600, same user). Read
 * lazily per request so sidecar restarts (which re-mint) never go stale.
 */
function readDesktopToken(): string | null {
  try {
    const dataDir = process.env.COMATE_DATA_DIR ?? path.join(os.homedir(), '.comate')
    const raw = fs.readFileSync(path.join(dataDir, 'desktop-auth.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { token?: unknown }
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null
  } catch {
    return null
  }
}

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
      '@server': path.resolve(__dirname, './src/server'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (proxyReq.hasHeader('authorization')) return
            const token = readDesktopToken()
            if (token) {
              proxyReq.setHeader('authorization', `Bearer ${token}`)
            }
          })
        },
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
