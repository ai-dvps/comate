import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { useUpdaterStore } from '../stores/updater-store'
import {
  canStartDownload,
  canRestart,
  checkForUpdates,
  handleDownloadEvent,
  startPeriodicUpdateChecks,
  stopPeriodicUpdateChecks,
} from './updater-api'
import { MISSING_UPDATE_FEED_ERROR } from '../../shared/updater-contract'

type TestWindow = {
  comate?: {
    updater?: {
      check?: () => Promise<null>
    }
  }
}

function installUpdaterCheck(check: () => Promise<null>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { comate: { updater: { check } } } satisfies TestWindow,
  })
}

describe('canStartDownload', () => {
  it('returns false when already downloading, ready, or restarting', () => {
    assert.strictEqual(canStartDownload('downloading'), false)
    assert.strictEqual(canStartDownload('ready'), false)
    assert.strictEqual(canStartDownload('restarting'), false)
  })

  it('returns true for idle, checking, and available', () => {
    assert.strictEqual(canStartDownload('idle'), true)
    assert.strictEqual(canStartDownload('checking'), true)
    assert.strictEqual(canStartDownload('available'), true)
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

describe('checkForUpdates', () => {
  beforeEach(() => {
    useUpdaterStore.setState({
      status: 'idle',
      update: null,
      downloadProgress: 0,
      error: null,
    })
  })

  afterEach(() => {
    stopPeriodicUpdateChecks()
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('returns false and preserves the updater error for the UI', async () => {
    installUpdaterCheck(() => Promise.reject(new Error('app-update.yml is missing')))

    assert.strictEqual(await checkForUpdates(), false)
    assert.strictEqual(useUpdaterStore.getState().status, 'idle')
    assert.match(useUpdaterStore.getState().error ?? '', /app-update\.yml is missing/)
  })

  it('normalizes a packaged missing-feed IPC error for localization', async () => {
    installUpdaterCheck(() => Promise.reject(new Error(`Error invoking updater: ${MISSING_UPDATE_FEED_ERROR}`)))

    assert.strictEqual(await checkForUpdates(), false)
    assert.strictEqual(useUpdaterStore.getState().error, MISSING_UPDATE_FEED_ERROR)
  })

  it('returns true after a successful no-update check', async () => {
    installUpdaterCheck(() => Promise.resolve(null))

    assert.strictEqual(await checkForUpdates(), true)
    assert.strictEqual(useUpdaterStore.getState().status, 'idle')
    assert.strictEqual(useUpdaterStore.getState().error, null)
  })

  it('does not record a failed automatic check as successful', async () => {
    installUpdaterCheck(() => Promise.reject(new Error('update feed unavailable')))
    let successfulChecks = 0

    startPeriodicUpdateChecks(
      () => ({ autoCheckUpdates: true }),
      () => {
        successfulChecks += 1
      },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.strictEqual(successfulChecks, 0)
    assert.match(useUpdaterStore.getState().error ?? '', /update feed unavailable/)
  })
})
