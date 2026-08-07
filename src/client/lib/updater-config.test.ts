import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * U2: the updater endpoint source of truth moved from
 * src-tauri/tauri.conf.json (plugins.updater.endpoints) to
 * electron-builder.config.ts (publish provider). electron-builder has no
 * "endpoints" field — GitHub releases are addressed by owner/repo, which the
 * updater resolves to github.com/<owner>/<repo>/releases.
 */
describe('updater configuration', () => {
  it('publishes updates to the current GitHub repository', () => {
    const configPath = resolve(process.cwd(), 'electron-builder.config.ts')
    const raw = readFileSync(configPath, 'utf-8')

    assert.ok(
      /provider:\s*['"]github['"]/.test(raw),
      'electron-builder.config.ts must configure the github publish provider',
    )
    assert.ok(
      /owner:\s*['"]ai-dvps['"]/.test(raw),
      'electron-builder.config.ts must publish to the ai-dvps owner',
    )
    assert.ok(
      /repo:\s*['"]comate['"]/.test(raw),
      'electron-builder.config.ts must publish to the comate repository',
    )
  })
})
