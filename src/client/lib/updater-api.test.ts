import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { useUpdaterStore } from '../stores/updater-store'
import { canStartDownload, canRestart, handleDownloadEvent } from './updater-api'

describe('canStartDownload', () => {
  it('returns false when already downloading, ready, or restarting', () => {
    assert.strictEqual(canStartDownload('downloading'), false)
    assert.strictEqual(canStartDownload('ready'), false)
    assert.strictEqual(canStartDownload('restarting'), false)
  })

  it('returns true for idle, checking, available, and error', () => {
    assert.strictEqual(canStartDownload('idle'), true)
    assert.strictEqual(canStartDownload('checking'), true)
    assert.strictEqual(canStartDownload('available'), true)
    assert.strictEqual(canStartDownload('error'), true)
  })
})

describe('canRestart', () => {
  it('returns true only when status is ready', () => {
    assert.strictEqual(canRestart('ready'), true)
    assert.strictEqual(canRestart('idle'), false)
    assert.strictEqual(canRestart('checking'), false)
    assert.strictEqual(canRestart('available'), false)
    assert.strictEqual(canRestart('downloading'), false)
    assert.strictEqual(canRestart('restarting'), false)
    assert.strictEqual(canRestart('error'), false)
  })
})

describe('handleDownloadEvent', () => {
  beforeEach(() => {
    useUpdaterStore.setState({
      status: 'idle',
      update: null,
      downloadProgress: 0,
      error: null,
    })
  })

  it('computes download progress from Started contentLength and Progress chunks', () => {
    handleDownloadEvent({ event: 'Started', data: { contentLength: 100 } })
    assert.strictEqual(useUpdaterStore.getState().status, 'downloading')
    assert.strictEqual(useUpdaterStore.getState().downloadProgress, 0)

    handleDownloadEvent({ event: 'Progress', data: { chunkLength: 25 } })
    assert.strictEqual(useUpdaterStore.getState().downloadProgress, 25)

    handleDownloadEvent({ event: 'Progress', data: { chunkLength: 50 } })
    assert.strictEqual(useUpdaterStore.getState().downloadProgress, 75)

    handleDownloadEvent({ event: 'Finished' })
    assert.strictEqual(useUpdaterStore.getState().status, 'ready')
    assert.strictEqual(useUpdaterStore.getState().downloadProgress, 100)
  })

  it('keeps progress at zero when the server does not report contentLength', () => {
    handleDownloadEvent({ event: 'Started', data: {} })
    handleDownloadEvent({ event: 'Progress', data: { chunkLength: 25 } })
    assert.strictEqual(useUpdaterStore.getState().downloadProgress, 0)
  })

  it('resets accumulated bytes on each new Started event', () => {
    handleDownloadEvent({ event: 'Started', data: { contentLength: 100 } })
    handleDownloadEvent({ event: 'Progress', data: { chunkLength: 80 } })
    assert.strictEqual(useUpdaterStore.getState().downloadProgress, 80)

    handleDownloadEvent({ event: 'Started', data: { contentLength: 200 } })
    handleDownloadEvent({ event: 'Progress', data: { chunkLength: 50 } })
    assert.strictEqual(useUpdaterStore.getState().downloadProgress, 25)
  })
})
