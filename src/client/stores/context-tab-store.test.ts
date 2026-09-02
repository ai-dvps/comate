import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WsEventMessage } from '@server/websocket/types'
import { commitDiffTabId, useContextTabStore } from './context-tab-store'
import { useBrowserPaneStore } from './browser-pane-store'

const wsClientMock = vi.hoisted(() => {
  type Listener = (msg: WsEventMessage) => void
  const listeners = new Set<Listener>()
  return {
    request: vi.fn(() => Promise.resolve({})),
    onEvent: vi.fn((cb: Listener) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    }),
    onReconnect: vi.fn(() => () => {}),
    onDisconnect: vi.fn(() => () => {}),
    emitEvent: (msg: WsEventMessage) => {
      for (const listener of [...listeners]) listener(msg)
    },
  }
})

vi.mock('../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

function browserClosedEvent(sessionId: string): WsEventMessage {
  return {
    type: 'event',
    eventType: 'browser_closed',
    sessionId,
    workspaceId: 'ws-1',
    data: { type: 'browser_closed', sessionId, workspaceId: 'ws-1' },
  }
}

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

  // -- browser_closed event: the tab retires with the browser -----------------

  it('removes the Browser tab and clears the pane open flag when the browser closes', async () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    await store.openFile('ws-1', 'a.ts', 'a.ts')
    store.openBrowser('session-a', 'ws-1')
    useBrowserPaneStore.getState().setPaneOpen('session-a', true)
    expect(useContextTabStore.getState().activeTabId).toBe('browser:session-a')

    wsClientMock.emitEvent(browserClosedEvent('session-a'))

    // The tab is gone and the selection falls back to the remaining tab.
    expect(useContextTabStore.getState().openTabs.map((tab) => tab.id)).toEqual(['file:a.ts'])
    expect(useContextTabStore.getState().activeTabId).toBe('file:a.ts')
    expect(useBrowserPaneStore.getState().openBySession['session-a']).toBe(false)
  })

  it('does not ask the server to close again when the event drives the removal', () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    store.openBrowser('session-a', 'ws-1')
    wsClientMock.request.mockClear()

    wsClientMock.emitEvent(browserClosedEvent('session-a'))

    // The event IS the close — re-sending browserClose would be a loop.
    expect(wsClientMock.request).not.toHaveBeenCalledWith('browserClose', expect.anything())
    expect(useContextTabStore.getState().openTabs).toEqual([])
  })

  it('is a no-op for a session without a Browser tab', () => {
    const before = useContextTabStore.getState().openTabs
    wsClientMock.emitEvent(browserClosedEvent('session-unknown'))
    expect(useContextTabStore.getState().openTabs).toBe(before)
  })

  it('keeps the current selection when a background session browser closes', async () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    await store.openFile('ws-1', 'a.ts', 'a.ts')
    // A background session's tab is not projected while session-a is active.
    store.openBrowser('session-b', 'ws-1')
    expect(useContextTabStore.getState().activeTabId).toBe('file:a.ts')

    wsClientMock.emitEvent(browserClosedEvent('session-b'))

    expect(useContextTabStore.getState().openTabs.map((tab) => tab.id)).toEqual(['file:a.ts'])
    expect(useContextTabStore.getState().activeTabId).toBe('file:a.ts')
    expect(useContextTabStore.getState().sessionTabs['session-b']?.tabs ?? []).toEqual([])
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

  it('creates one Workspace Git Graph tab and keeps it across Session changes', () => {
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    store.openGitGraph('ws-1')
    store.openGitGraph('ws-1')

    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'git-graph', id: 'git-graph', workspaceId: 'ws-1', name: 'Git Graph' },
    ])

    store.setContext('ws-1', 'session-b')
    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'git-graph', workspaceId: 'ws-1' },
    ])
    store.setContext('ws-2', 'session-c')
    store.openGitGraph('ws-2')
    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'git-graph', workspaceId: 'ws-2' },
    ])
  })

  it('uses commit, base, old path and new path in historical Diff identity', () => {
    expect(commitDiffTabId('same', null, undefined, 'src/file.ts', 'repo-a'))
      .not.toBe(commitDiffTabId('same', null, undefined, 'src/file.ts', 'repo-b'))
    expect(commitDiffTabId('commit-a', 'base-a', 'old/file.ts', 'src/file.ts'))
      .not.toBe(commitDiffTabId('commit-b', 'base-a', 'old/file.ts', 'src/file.ts'))
    expect(commitDiffTabId('commit-a', 'base-a', 'old/file.ts', 'src/file.ts'))
      .not.toBe(commitDiffTabId('commit-a', 'base-b', 'old/file.ts', 'src/file.ts'))
    expect(commitDiffTabId('commit-a', 'base-a', 'old/file.ts', 'src/file.ts'))
      .not.toBe(commitDiffTabId('commit-a', 'base-a', 'older/file.ts', 'src/file.ts'))
    expect(commitDiffTabId('commit-a', 'base-a', 'old/file.ts', 'src/file.ts'))
      .not.toBe(commitDiffTabId('commit-a', 'base-a', 'old/file.ts', 'other/file.ts'))
  })

  it('keeps identical commit paths in different repositories in separate Diff tabs', async () => {
    global.fetch = vi.fn(async (input) => {
      const repositoryId = new URL(String(input), 'http://localhost').searchParams.get('repositoryId')
      return { ok: true, json: async () => ({ repositoryId, commitHash: 'same', baseHash: null, path: 'src/file.ts', status: 'A', original: '', modified: repositoryId, isTextComparable: true, isBinary: false, truncated: false, isDeleted: false }) } as Response
    }) as typeof fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', null)
    const file = { path: 'src/file.ts', status: 'A' as const, additions: 1, deletions: 0, isBinary: false, isGitlink: false }
    await store.openCommitDiff('ws-1', 'same', null, file, { id: 'a', name: 'A', relativePath: 'apps/a' })
    await store.openCommitDiff('ws-1', 'same', null, file, { id: 'b', name: 'B', relativePath: 'apps/b' })
    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { repository: { id: 'a' }, modified: 'a' }, { repository: { id: 'b' }, modified: 'b' },
    ])
  })

  it('opens commit-specific Diffs without replacing or resetting Git Graph', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        commitHash: 'commit-a',
        baseHash: 'base-a',
        path: 'src/file.ts',
        oldPath: 'old/file.ts',
        status: 'R',
        original: 'before',
        modified: 'after',
        isBinary: false,
        isTextComparable: true,
        truncated: true,
        isDeleted: false,
      }),
    })) as unknown as typeof global.fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', 'session-a')
    store.openGitGraph('ws-1')
    await store.openCommitDiff('ws-1', 'commit-a', 'base-a', {
      path: 'src/file.ts',
      oldPath: 'old/file.ts',
      status: 'R',
      additions: 1,
      deletions: 1,
      isBinary: false,
      isGitlink: false,
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/git-graph/commit-a/diff?path=src%2Ffile.ts',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'git-graph' },
      {
        type: 'commit-diff',
        commitHash: 'commit-a',
        baseHash: 'base-a',
        oldPath: 'old/file.ts',
        path: 'src/file.ts',
        original: 'before',
        modified: 'after',
        truncated: true,
        loading: false,
      },
    ])

    const diff = useContextTabStore.getState().openTabs.at(-1)!
    store.closeTab(diff.id)
    expect(useContextTabStore.getState().openTabs).toMatchObject([{ type: 'git-graph' }])
  })

  it('keeps explicit binary and Gitlink comparison state', async () => {
    const responses = [
      {
        commitHash: 'binary-commit', baseHash: 'base', path: 'image.png', status: 'M',
        original: '', modified: '', isBinary: true, isTextComparable: false,
        uncomparableReason: 'binary', truncated: false, isDeleted: false,
      },
      {
        commitHash: 'gitlink-commit', baseHash: 'base', path: 'vendor/submodule', status: 'M',
        original: '', modified: '', isBinary: false, isTextComparable: false,
        uncomparableReason: 'gitlink', truncated: false, isDeleted: false,
      },
    ]
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(responses.shift()),
    })) as unknown as typeof global.fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', null)
    await store.openCommitDiff('ws-1', 'binary-commit', 'base', {
      path: 'image.png', status: 'M', additions: null, deletions: null,
      isBinary: true, isGitlink: false,
    })
    await store.openCommitDiff('ws-1', 'gitlink-commit', 'base', {
      path: 'vendor/submodule', status: 'M', additions: null, deletions: null,
      isBinary: false, isGitlink: true,
    })

    expect(useContextTabStore.getState().openTabs).toMatchObject([
      { type: 'commit-diff', isBinary: true, isTextComparable: false, uncomparableReason: 'binary' },
      { type: 'commit-diff', isGitlink: true, isTextComparable: false, uncomparableReason: 'gitlink' },
    ])
  })

  it('aborts an in-flight historical Diff when its tab closes', async () => {
    let requestSignal: AbortSignal | undefined
    global.fetch = vi.fn((_url, init) => {
      requestSignal = (init as RequestInit).signal as AbortSignal
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as unknown as typeof global.fetch
    const store = useContextTabStore.getState()
    store.setContext('ws-1', null)
    const opening = store.openCommitDiff('ws-1', 'commit-a', null, {
      path: 'root.ts', status: 'A', additions: 1, deletions: 0,
      isBinary: false, isGitlink: false,
    })
    const pending = useContextTabStore.getState().openTabs[0]
    store.closeTab(pending.id)
    await opening

    expect(requestSignal?.aborted).toBe(true)
    expect(useContextTabStore.getState().openTabs).toEqual([])
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
