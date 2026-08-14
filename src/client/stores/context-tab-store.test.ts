import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useContextTabStore } from './context-tab-store'

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

  it('deduplicates a Session Browser tab', () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    store.openBrowser('session-a', 'ws-1')
    store.openBrowser('session-a', 'ws-1')

    expect(useContextTabStore.getState().openTabs).toHaveLength(1)
    expect(useContextTabStore.getState().activeTabId).toBe('browser:session-a')
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
