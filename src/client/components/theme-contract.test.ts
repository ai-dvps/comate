import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8')
}

describe('Comate theme contract', () => {
  it('defines brand, Agent activity, and attention colors in both themes', async () => {
    const css = await source('src/client/index.css')

    expect(css.match(/--color-accent:/g)).toHaveLength(2)
    expect(css.match(/--color-agent:/g)).toHaveLength(2)
    expect(css.match(/--color-attention:/g)).toHaveLength(2)
    expect(css).toContain('--color-accent: 221 78% 31%')
    expect(css).toContain('--color-accent: 211 82% 67%')
  })

  it('exposes activity and attention as semantic Tailwind colors', async () => {
    const config = await source('tailwind.config.js')

    expect(config).toContain("agent: 'hsl(var(--color-agent) / <alpha-value>)'")
    expect(config).toContain("attention: 'hsl(var(--color-attention) / <alpha-value>)'")
  })

  it('keeps running and user-attention states semantically distinct', async () => {
    const status = await source('src/client/components/StatusIndicator.tsx')
    const tasks = await source('src/client/components/TaskPanel.tsx')
    const commandCenter = await source('src/client/components/AgentCommandCenter.tsx')
    const permissions = await source('src/client/components/PermissionsSubTab.tsx')

    expect(status).toContain("'needs-me': 'text-attention'")
    expect(status).toContain("streaming: 'text-agent animate-spin'")
    expect(tasks).toContain("iconClass: 'text-agent animate-spin'")
    expect(commandCenter).toContain('bg-agent ring-1 ring-chrome')
    expect(commandCenter).toContain('bg-attention/15')
    expect(permissions).toContain("'bg-attention/15 text-attention'")
  })

  it('uses theme-aware foreground text on primary buttons', async () => {
    const files = [
      'src/client/App.tsx',
      'src/client/components/NewChatPage.tsx',
      'src/client/components/ScheduledTaskForm.tsx',
      'src/client/components/AgentCommandCenter.tsx',
      'src/client/components/browser/BrowserStateBar.tsx',
      'src/client/components/browser/BrowserDetachedPlaceholder.tsx',
      'src/client/components/ui/date-time-field.tsx',
    ]
    const combined = (await Promise.all(files.map(source))).join('\n')

    expect(combined).not.toMatch(/bg-accent[^\n"']*text-white/)
    expect(combined).toContain('text-accent-foreground')
  })

  it('uses the official Comate mark in startup and recovery states', async () => {
    const app = await source('src/client/App.tsx')

    expect(app).toContain("import comateIconUrl from '../../build/icon.png'")
    expect(app).not.toContain('from-orange-400 to-red-500')
  })
})
