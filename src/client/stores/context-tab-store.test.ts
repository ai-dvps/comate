import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useContextTabStore } from './context-tab-store'
import { useBrowserPaneStore } from './browser-pane-store'

function resetStore() {
  useContextTabStore.getState().reset()
  vi.clearAllMocks()
  global.fetch = vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ content: 'content', isBinary: false }),
  })) as unknown as typeof global.fetch
}

describe('context-tab-store', () => {
  beforeEach(resetStore)

  it('projects Workspace tabs with only the active Session Browser tab', async () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    await store.openFile('ws-1', 'src/App.tsx', 'App.tsx')
    store.openBrowser('session-a', 'ws-1')
    store.openBrowser('session-b', 'ws-1')

    expect(useContextTabStore.getState().openTabs.map((tab) => tab.type)).toEqual([
      'file',
      'browser',
    ])

    store.setContext('ws-1', 'session-b')
    expect(useContextTabStore.getState().openTabs.map((tab) => tab.type)).toEqual([
      'file',
      'browser',
    ])
    expect(useContextTabStore.getState().openTabs.at(-1)).toMatchObject({
      type: 'browser',
      sessionId: 'session-b',
    })
  })

  it('isolates File and Changes tabs by Workspace', async () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    await store.openFile('ws-1', 'one.ts', 'one.ts')
    store.setContext('ws-2', 'session-b')
    await store.openFile('ws-2', 'two.ts', 'two.ts')

    expect(useContextTabStore.getState().openTabs.map((tab) => tab.name)).toEqual(['two.ts'])
    store.setContext('ws-1', 'session-a')
    expect(useContextTabStore.getState().openTabs.map((tab) => tab.name)).toEqual(['one.ts'])
  })

  it('replaces a preview slot and promotes it without refetching', async () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    await store.openFile('ws-1', 'one.ts', 'one.ts', { preview: true })
    await store.openFile('ws-1', 'two.ts', 'two.ts', { preview: true })

    expect(useContextTabStore.getState().openTabs).toHaveLength(1)
    expect(useContextTabStore.getState().openTabs[0]).toMatchObject({
      id: 'file:preview',
      path: 'two.ts',
      preview: true,
    })

    await store.openFile('ws-1', 'two.ts', 'two.ts')
    expect(useContextTabStore.getState().openTabs[0]).toMatchObject({
      id: 'file:two.ts',
      path: 'two.ts',
      preview: false,
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('opens supported videos with a stream URL instead of treating them as generic binary files', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        content: null,
        isBinary: true,
        mimeType: 'video/mp4',
      }),
    })) as unknown as typeof global.fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')

    await store.openFile('ws-1', 'media/demo clip.mp4', 'demo clip.mp4')

    expect(useContextTabStore.getState().openTabs[0]).toMatchObject({
      type: 'file',
      path: 'media/demo clip.mp4',
      isBinary: true,
      videoUrl: '/api/workspaces/ws-1/files/media?path=media%2Fdemo%20clip.mp4',
    })
  })

  it('opens supported audio with a stream URL instead of treating them as generic binary files', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        content: null,
        isBinary: true,
        mimeType: 'audio/wav',
      }),
    })) as unknown as typeof global.fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')

    await store.openFile('ws-1', 'media/tone.wav', 'tone.wav')

    expect(useContextTabStore.getState().openTabs[0]).toMatchObject({
      type: 'file',
      path: 'media/tone.wav',
      isBinary: true,
      audioUrl: '/api/workspaces/ws-1/files/media?path=media%2Ftone.wav',
    })
  })

  it('ignores a stale File preview that resolves after a newer path', async () => {
    const resolvers = new Map<string, (value: unknown) => void>()
    global.fetch = vi.fn((url) => new Promise((resolve) => {
      resolvers.set(String(url), resolve)
    })) as unknown as typeof global.fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')

    const first = store.openFile('ws-1', 'first.ts', 'first.ts', { preview: true })
    const second = store.openFile('ws-1', 'second.ts', 'second.ts', { preview: true })
    resolvers.get('/api/workspaces/ws-1/files/content?path=second.ts')?.({
      ok: true,
      json: () => Promise.resolve({ content: 'second', isBinary: false }),
    })
    await second
    resolvers.get('/api/workspaces/ws-1/files/content?path=first.ts')?.({
      ok: true,
      json: () => Promise.resolve({ content: 'first', isBinary: false }),
    })
    await first

    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'file', path: 'second.ts', content: 'second' },
    ])
  })

  it('ignores a stale Changes preview that resolves after a newer path', async () => {
    const resolvers = new Map<string, (value: unknown) => void>()
    global.fetch = vi.fn((url) => new Promise((resolve) => {
      resolvers.set(String(url), resolve)
    })) as unknown as typeof global.fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')

    const first = store.openDiff('ws-1', {
      path: 'first.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
    }, false, { preview: true })
    const second = store.openDiff('ws-1', {
      path: 'second.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
    }, false, { preview: true })
    resolvers.get('/api/workspaces/ws-1/git-changes/compare?path=second.ts&staged=false')?.({
      ok: true,
      json: () => Promise.resolve({ original: 'old second', modified: 'new second' }),
    })
    await second
    resolvers.get('/api/workspaces/ws-1/git-changes/compare?path=first.ts&staged=false')?.({
      ok: true,
      json: () => Promise.resolve({ original: 'old first', modified: 'new first' }),
    })
    await first

    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'changes', path: 'second.ts', modified: 'new second' },
    ])
  })

  it('deduplicates a Session Browser tab', () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    store.openBrowser('session-a', 'ws-1')
    store.openBrowser('session-a', 'ws-1')

    expect(useContextTabStore.getState().openTabs).toHaveLength(1)
    expect(useContextTabStore.getState().activeTabId).toBe('browser:session-a')
  })

  it('terminates only an explicitly closed Browser tab', () => {
    const close = vi.fn(() => Promise.resolve())
    useBrowserPaneStore.setState({ close })
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    store.openBrowser('session-a', 'ws-1')
    store.closeTab('browser:session-a')

    expect(close).toHaveBeenCalledWith('session-a')
    expect(useContextTabStore.getState().openTabs).toEqual([])
  })

  it('creates one empty File or Changes workspace tab from the add menu', () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    store.openFileWorkspace('ws-1')
    store.openFileWorkspace('ws-1')
    store.openChangesWorkspace('ws-1')

    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'file', id: 'file:preview', name: 'Files', path: '' },
      { type: 'changes', id: 'changes:preview', name: 'Changes', path: '' },
    ])
  })

  it('selects the nearest projected tab after closing the active tab', async () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    await store.openFile('ws-1', 'a.ts', 'a.ts')
    await store.openFile('ws-1', 'b.ts', 'b.ts')
    store.openBrowser('session-a', 'ws-1')
    store.selectTab('file:b.ts')
    store.closeTab('file:b.ts')

    expect(useContextTabStore.getState().activeTabId).toBe('browser:session-a')
  })

  it('aborts late requests when a Workspace is cleared', async () => {
    let signal: AbortSignal | undefined
    global.fetch = vi.fn((_url, init) => {
      signal = (init as { signal?: AbortSignal }).signal
      return new Promise(() => {})
    }) as unknown as typeof global.fetch

    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    void store.openFile('ws-1', 'late.ts', 'late.ts')
    await Promise.resolve()
    store.clearWorkspace('ws-1')

    expect(signal?.aborted).toBe(true)
    expect(useContextTabStore.getState().openTabs).toEqual([])
  })
})
