import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { ComateBridge, DownloadEvent } from './desktop-api'

/**
 * U2 bridge coverage: the six shell capabilities routed through
 * `window.comate`, the 50×200ms api-info retry semantics, the /api fetch
 * rewrite, and the plain-browser degradation when the bridge is absent.
 */

type MutableWindow = Window & { comate?: Partial<ComateBridge> }

function installBridge(bridge: Partial<ComateBridge>): void {
  (window as MutableWindow).comate = bridge
}

function removeBridge(): void {
  delete (window as MutableWindow).comate
}

async function importBridge() {
  return import('./desktop-api')
}

beforeEach(() => {
  vi.resetModules()
  removeBridge()
})

afterEach(() => {
  removeBridge()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('bridge detection', () => {
  it('reports isDesktop false without window.comate and true with it', async () => {
    const api = await importBridge()
    expect(api.isDesktop()).toBe(false)
    installBridge({ getApiInfo: () => Promise.resolve({ port: 1, token: 't' }) })
    expect(api.isDesktop()).toBe(true)
  })
})

describe('api info (port/token drives fetch rewrite and WS URL)', () => {
  it('derives base, token, and WebSocket URL from the bridge api info', async () => {
    installBridge({ getApiInfo: () => Promise.resolve({ port: 9123, token: 'secret' }) })
    const api = await importBridge()
    await expect(api.getApiBase()).resolves.toBe('http://localhost:9123')
    await expect(api.getApiToken()).resolves.toBe('secret')
    await expect(api.getWebSocketUrl()).resolves.toBe('ws://localhost:9123/ws')
  })

  it('resolves empty values without the bridge (pure browser dev:client)', async () => {
    const api = await importBridge()
    await expect(api.getApiBase()).resolves.toBe('')
    await expect(api.getApiToken()).resolves.toBe('')
    await expect(api.getWebSocketUrl()).resolves.toBe('')
  })

  it('retries while the bridge info is not ready, then succeeds', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const getApiInfo = vi.fn(() => {
      attempts += 1
      return attempts < 3
        ? Promise.reject(new Error('API port not yet discovered'))
        : Promise.resolve({ port: 9000, token: 'tok' })
    })
    installBridge({ getApiInfo })
    const api = await importBridge()

    const basePromise = api.getApiBase()
    const assertion = expect(basePromise).resolves.toBe('http://localhost:9000')
    await vi.advanceTimersByTimeAsync(2 * 200)
    await assertion
    expect(getApiInfo).toHaveBeenCalledTimes(3)
  })

  it('gives up after 50 retries (50×200ms) and resolves empty', async () => {
    vi.useFakeTimers()
    const getApiInfo = vi.fn(() => Promise.reject(new Error('down')))
    installBridge({ getApiInfo })
    const api = await importBridge()

    const basePromise = api.getApiBase()
    const assertion = expect(basePromise).resolves.toBe('')
    await vi.advanceTimersByTimeAsync(50 * 200)
    await assertion
    expect(getApiInfo).toHaveBeenCalledTimes(50)
  })
})

describe('initDesktopApi fetch rewrite', () => {
  let originalFetch: typeof window.fetch

  beforeEach(() => {
    originalFetch = window.fetch
  })

  afterEach(() => {
    window.fetch = originalFetch
  })

  it('rewrites /api requests to the sidecar base and injects the Bearer token', async () => {
    installBridge({ getApiInfo: () => Promise.resolve({ port: 9123, token: 'secret' }) })
    const api = await importBridge()
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')))
    window.fetch = fetchSpy as unknown as typeof window.fetch

    api.initDesktopApi()
    await window.fetch('/api/workspaces')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [input, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(input).toBe('http://localhost:9123/api/workspaces')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret')
  })

  it('leaves non-/api requests untouched', async () => {
    installBridge({ getApiInfo: () => Promise.resolve({ port: 9123, token: 'secret' }) })
    const api = await importBridge()
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')))
    window.fetch = fetchSpy as unknown as typeof window.fetch

    api.initDesktopApi()
    await window.fetch('https://example.com/data')

    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/data', undefined)
  })

  it('does not override an explicit Authorization header', async () => {
    installBridge({ getApiInfo: () => Promise.resolve({ port: 9123, token: 'secret' }) })
    const api = await importBridge()
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')))
    window.fetch = fetchSpy as unknown as typeof window.fetch

    api.initDesktopApi()
    await window.fetch('/api/x', { headers: { Authorization: 'Bearer per-session' } })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer per-session')
  })

  it('is a no-op without the bridge', async () => {
    const api = await importBridge()
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')))
    window.fetch = fetchSpy as unknown as typeof window.fetch

    api.initDesktopApi()
    expect(window.fetch).toBe(fetchSpy)
  })
})

describe('shell capabilities through the bridge', () => {
  it('showWindow delegates to the bridge and is a no-op without it', async () => {
    const showWindow = vi.fn(() => Promise.resolve())
    installBridge({ getApiInfo: vi.fn(), showWindow })
    const api = await importBridge()
    await api.showWindow()
    expect(showWindow).toHaveBeenCalledTimes(1)

    removeBridge()
    await expect(api.showWindow()).resolves.toBeUndefined()
  })

  it('reports and subscribes to the main window maximized state', async () => {
    const isWindowMaximized = vi.fn(() => Promise.resolve(true))
    const unsubscribe = vi.fn()
    let maximizedHandler: ((maximized: boolean) => void) | undefined
    installBridge({
      getApiInfo: vi.fn(),
      isWindowMaximized,
      onWindowMaximizedChange: (handler) => {
        maximizedHandler = handler
        return unsubscribe
      },
    })
    const api = await importBridge()
    const handler = vi.fn()

    await expect(api.isWindowMaximized()).resolves.toBe(true)
    const stopListening = api.onWindowMaximizedChange(handler)
    maximizedHandler?.(false)

    expect(handler).toHaveBeenCalledWith(false)
    stopListening()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    removeBridge()
    await expect(api.isWindowMaximized()).resolves.toBe(false)
    expect(() => api.onWindowMaximizedChange(handler)()).not.toThrow()
  })

  it('updateBadgeState forwards the count and is a no-op without the bridge', async () => {
    const updateBadgeState = vi.fn(() => Promise.resolve())
    installBridge({ getApiInfo: vi.fn(), updateBadgeState })
    const api = await importBridge()
    await api.updateBadgeState(7)
    expect(updateBadgeState).toHaveBeenCalledWith(7)

    removeBridge()
    await expect(api.updateBadgeState(0)).resolves.toBeUndefined()
  })

  it('revealInFileManager forwards the path', async () => {
    const revealInFileManager = vi.fn(() => Promise.resolve())
    installBridge({ getApiInfo: vi.fn(), revealInFileManager })
    const api = await importBridge()
    await api.revealInFileManager('/project/README.md')
    expect(revealInFileManager).toHaveBeenCalledWith('/project/README.md')
  })

  it('revealInFileManager rejects without the bridge (degraded)', async () => {
    const api = await importBridge()
    await expect(api.revealInFileManager('/x')).rejects.toThrow(/unavailable/)
  })

  it('openExternal forwards the URL and rejects without the bridge', async () => {
    const openUrl = vi.fn(() => Promise.resolve())
    installBridge({ getApiInfo: vi.fn(), openUrl })
    const api = await importBridge()
    await api.openExternal('https://example.com')
    expect(openUrl).toHaveBeenCalledWith('https://example.com')

    removeBridge()
    await expect(api.openExternal('https://example.com')).rejects.toThrow(/unavailable/)
  })

  it('openDirectoryDialog returns the picked path, null without the bridge', async () => {
    const openDirectory = vi.fn(() => Promise.resolve('/picked/dir'))
    installBridge({ getApiInfo: vi.fn(), dialog: { openDirectory } })
    const api = await importBridge()
    await expect(api.openDirectoryDialog()).resolves.toBe('/picked/dir')

    removeBridge()
    await expect(api.openDirectoryDialog()).resolves.toBeNull()
  })

  it('notification wrappers delegate to the bridge and reject without it', async () => {
    const send = vi.fn()
    installBridge({
      getApiInfo: vi.fn(),
      notifications: {
        isPermissionGranted: () => Promise.resolve(true),
        requestPermission: () => Promise.resolve(true),
        send,
        onAction: () => Promise.resolve(),
      },
    })
    const api = await importBridge()
    await expect(api.isNotificationPermissionGranted()).resolves.toBe(true)
    await expect(api.requestNotificationPermission()).resolves.toBe(true)
    api.sendDesktopNotification({ title: 'hi' })
    expect(send).toHaveBeenCalledWith({ title: 'hi' })
    await expect(api.onNotificationAction(() => {})).resolves.toBeUndefined()

    removeBridge()
    await expect(api.isNotificationPermissionGranted()).rejects.toThrow(/unavailable/)
    expect(() => api.sendDesktopNotification({ title: 'hi' })).toThrow(/unavailable/)
  })
})

describe('updater surface (U5: handle reconstructed over the IPC bridge)', () => {
  it('checkForUpdate resolves null without the bridge updater', async () => {
    const api = await importBridge()
    await expect(api.checkForUpdate()).resolves.toBeNull()

    installBridge({ getApiInfo: vi.fn() })
    const api2 = await importBridge()
    await expect(api2.checkForUpdate()).resolves.toBeNull()
  })

  it('checkForUpdate maps plain IPC info into a DesktopUpdate handle', async () => {
    const info = { currentVersion: '0.0.33', version: '0.0.34', body: 'notes' }
    installBridge({ getApiInfo: vi.fn(), updater: { check: () => Promise.resolve(info) } })
    const api = await importBridge()
    const update = await api.checkForUpdate()
    expect(update).toMatchObject(info)
    expect(typeof update?.downloadAndInstall).toBe('function')
  })

  it('downloadAndInstall invokes the bridge download and relays pushed events', async () => {
    const info = { currentVersion: '0.0.33', version: '0.0.34' }
    const download = vi.fn(() => Promise.resolve())
    let eventHandler: ((event: DownloadEvent) => void) | null = null
    const unsubscribe = vi.fn()
    installBridge({
      getApiInfo: vi.fn(),
      updater: {
        check: () => Promise.resolve(info),
        download,
        onDownloadEvent: (handler) => {
          eventHandler = handler
          return unsubscribe
        },
      },
    })
    const api = await importBridge()
    const update = await api.checkForUpdate()

    const received: DownloadEvent[] = []
    await update?.downloadAndInstall((event) => received.push(event))

    expect(download).toHaveBeenCalledTimes(1)
    // The subscription is live for the duration of the download, then removed.
    expect(eventHandler).not.toBeNull()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    const handler = eventHandler as unknown as (event: DownloadEvent) => void
    handler({ event: 'Progress', data: { chunkLength: 10 } })
    expect(received).toEqual([{ event: 'Progress', data: { chunkLength: 10 } }])
  })

  it('downloadAndInstall rejects when the bridge lacks updater.download', async () => {
    const info = { currentVersion: '0.0.33', version: '0.0.34' }
    installBridge({ getApiInfo: vi.fn(), updater: { check: () => Promise.resolve(info) } })
    const api = await importBridge()
    const update = await api.checkForUpdate()
    await expect(update?.downloadAndInstall()).rejects.toThrow(/unavailable/)
  })

  it('getAppVersion resolves null without the bridge, the version with it', async () => {
    const api = await importBridge()
    await expect(api.getAppVersion()).resolves.toBeNull()

    removeBridge()
    installBridge({ getApiInfo: vi.fn(), getVersion: () => Promise.resolve('0.0.33') })
    const api2 = await importBridge()
    await expect(api2.getAppVersion()).resolves.toBe('0.0.33')
  })
})
