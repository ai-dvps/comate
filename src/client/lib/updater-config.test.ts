import { describe, it } from 'node:test'
import assert from 'node:assert'
import { UPDATE_FEED } from '../../shared/updater-contract'

/**
 * U2: the updater endpoint source of truth moved from the legacy Tauri config
 * to the shared Electron updater contract. electron-builder and the release
 * guard both consume this exact provider/owner/repo tuple.
 */
describe('updater configuration', () => {
  it('publishes updates to the current GitHub repository', () => {
    assert.deepEqual(UPDATE_FEED, {
      provider: 'github',
      owner: 'ai-dvps',
      repo: 'comate',
    })
  })
})
