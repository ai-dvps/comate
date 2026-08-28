import { describe, it } from 'node:test'
import assert from 'node:assert'
import { GITEE_UPDATE_FEED, UPDATE_FEED } from '../../shared/updater-contract'

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

  it('defines the public Gitee release mirror as a generic updater feed', () => {
    assert.deepEqual(GITEE_UPDATE_FEED, {
      provider: 'generic',
      url: 'https://gitee.com/ai-dvps/comate/releases/download/latest',
      useMultipleRangeRequest: false,
    })
  })
})
