import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('updater configuration', () => {
  it('points the updater endpoint at the current repository', () => {
    const configPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json')
    const raw = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as {
      plugins?: { updater?: { endpoints?: string[] } }
    }
    const endpoint = config.plugins?.updater?.endpoints?.[0]
    assert.ok(endpoint, 'Updater endpoint is not configured')
    assert.ok(
      endpoint.includes('github.com/ai-dvps/comate/'),
      `Updater endpoint points to wrong repository: ${endpoint}`
    )
  })
})
