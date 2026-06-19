import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { useUpdaterStore } from './updater-store'

describe('useUpdaterStore', () => {
  beforeEach(() => {
    useUpdaterStore.setState({
      status: 'idle',
      update: null,
      downloadProgress: 0,
      error: null,
    })
  })

  it('starts in idle state', () => {
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'idle')
    assert.strictEqual(state.update, null)
    assert.strictEqual(state.downloadProgress, 0)
    assert.strictEqual(state.error, null)
  })

  it('transitions to checking', () => {
    useUpdaterStore.getState().setChecking()
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'checking')
    assert.strictEqual(state.error, null)
  })

  it('transitions from checking to available', () => {
    useUpdaterStore.getState().setChecking()
    useUpdaterStore.getState().setAvailable({
      currentVersion: '0.0.5',
      version: '0.0.6',
      body: 'Bug fixes',
    })
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'available')
    assert.deepStrictEqual(state.update, {
      currentVersion: '0.0.5',
      version: '0.0.6',
      body: 'Bug fixes',
    })
  })

  it('transitions to idle when no update exists', () => {
    useUpdaterStore.getState().setChecking()
    useUpdaterStore.getState().setIdle()
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'idle')
    assert.strictEqual(state.update, null)
  })

  it('tracks download progress', () => {
    useUpdaterStore.getState().setAvailable({ currentVersion: '0.0.5', version: '0.0.6' })
    useUpdaterStore.getState().setDownloading()
    useUpdaterStore.getState().setDownloadProgress(50, 100)
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'downloading')
    assert.strictEqual(state.downloadProgress, 50)
  })

  it('transitions to ready when download finishes', () => {
    useUpdaterStore.getState().setDownloading()
    useUpdaterStore.getState().setReady()
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'ready')
    assert.strictEqual(state.downloadProgress, 100)
  })

  it('surfaces download errors and allows retry', () => {
    useUpdaterStore.getState().setDownloading()
    useUpdaterStore.getState().setError('Network error')
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'idle')
    assert.strictEqual(state.error, 'Network error')
  })

  it('dismisses update and resets to idle', () => {
    useUpdaterStore.getState().setAvailable({ currentVersion: '0.0.5', version: '0.0.6' })
    useUpdaterStore.getState().dismissUpdate()
    const state = useUpdaterStore.getState()
    assert.strictEqual(state.status, 'idle')
    assert.strictEqual(state.update, null)
  })
})
