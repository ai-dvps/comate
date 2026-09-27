import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gitGraphKey, useGitGraphStore } from './git-graph-store'
import type { GitGraphCommit, GitGraphCommitDetail, GitGraphSnapshot } from './git-graph-store'

function commit(hash: string, options: Partial<GitGraphCommit> = {}): GitGraphCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authoredAt: '2026-08-30T00:00:00.000Z',
    subject: `Subject ${hash}`,
    refs: [],
    isHead: false,
    ...options,
  }
}

function snapshot(commits: GitGraphCommit[], hasMore = false): GitGraphSnapshot {
  return {
    capability: {
      isGitWorktree: true,
      state: 'attached',
      branch: 'main',
      ref: 'main',
      headHash: commits.find((item) => item.isHead)?.hash ?? commits[0]?.hash ?? null,
    },
    refs: commits.flatMap((item) => item.refs),
    commits,
    limit: commits.length,
    hasMore,
  }
}

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('git-graph-store', () => {
  beforeEach(() => {
    useGitGraphStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('binds requests and browsing state to repositories within one workspace', async () => {
    global.fetch = vi.fn((input) => {
      const id = new URL(String(input), 'http://localhost').searchParams.get('repositoryId')
      return Promise.resolve(response({ ...snapshot([commit(id!)]), repositoryId: id }))
    }) as typeof fetch
    const a = gitGraphKey('ws', 'a')
    const b = gitGraphKey('ws', 'b')
    await useGitGraphStore.getState().open(a)
    await useGitGraphStore.getState().open(b)
    useGitGraphStore.getState().setSearchText(a, 'Ada')
    useGitGraphStore.getState().setScrollAnchor(a, 42)
    expect(useGitGraphStore.getState().workspaces[a].selectedCommitHash).toBe('a')
    expect(useGitGraphStore.getState().workspaces[b].searchText).toBe('')
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/workspaces/ws/git-graph?')
    useGitGraphStore.getState().clearWorkspace('ws')
    expect(useGitGraphStore.getState().workspaces).toEqual({})
  })

  it('rejects a response from a different repository', async () => {
    global.fetch = vi.fn().mockResolvedValue(response({ ...snapshot([commit('wrong')]), repositoryId: 'b' }))
    const a = gitGraphKey('ws', 'a')
    await useGitGraphStore.getState().open(a)
    expect(useGitGraphStore.getState().workspaces[a].snapshot).toBeNull()
    expect(useGitGraphStore.getState().workspaces[a].snapshotError).toBeTruthy()
  })

  it('isolates workspace filters, selections, anchors, and results', async () => {
    global.fetch = vi.fn((input) => {
      const url = String(input)
      return Promise.resolve(response(snapshot([
        commit(url.includes('ws-a') ? 'a' : 'b', { isHead: true }),
      ])))
    }) as typeof fetch

    await useGitGraphStore.getState().open('ws-a')
    await useGitGraphStore.getState().open('ws-b')
    useGitGraphStore.getState().setSearchText('ws-a', 'ada')
    useGitGraphStore.getState().setScrollAnchor('ws-a', 42)
    await useGitGraphStore.getState().setFilters('ws-b', ['refs/heads/topic'])

    const state = useGitGraphStore.getState().workspaces
    expect(state['ws-a']).toMatchObject({ selectedCommitHash: 'a', searchText: 'ada', scrollAnchor: 42, selectedRefs: [] })
    expect(state['ws-b']).toMatchObject({ selectedCommitHash: 'b', searchText: '', scrollAnchor: null, selectedRefs: ['refs/heads/topic'] })
  })

  it('loads more without resetting filters or search and expands loaded-window matches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot([commit('one')], true)))
      .mockResolvedValueOnce(response(snapshot([commit('one'), commit('two', { subject: 'needle' })])))
    global.fetch = fetchMock as typeof fetch

    await useGitGraphStore.getState().setFilters('ws', ['refs/heads/main'])
    useGitGraphStore.getState().setSearchText('ws', 'needle')
    expect(useGitGraphStore.getState().workspaces.ws.searchMatches).toEqual([])
    await useGitGraphStore.getState().loadMore('ws')

    expect(useGitGraphStore.getState().workspaces.ws).toMatchObject({
      selectedRefs: ['refs/heads/main'],
      searchText: 'needle',
      searchMatches: ['two'],
    })
    expect(String(fetchMock.mock.calls[1][0])).toContain('ref=refs%2Fheads%2Fmain')
  })

  it('does not request history beyond the server limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(snapshot([commit('head')], true)))
    global.fetch = fetchMock as typeof fetch
    await useGitGraphStore.getState().open('ws')
    useGitGraphStore.setState((state) => ({
      workspaces: {
        ...state.workspaces,
        ws: { ...state.workspaces.ws, loadedLimit: 500 },
      },
    }))
    fetchMock.mockClear()

    await useGitGraphStore.getState().loadMore('ws')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('matches only loaded author, subject, SHA, and refs and navigates matches', async () => {
    const tagged = commit('abcdef123', {
      authorName: 'Grace Hopper',
      subject: 'Compiler work',
      refs: [{ fullName: 'refs/tags/v1', name: 'v1', type: 'tag', hash: 'abcdef123' }],
    })
    global.fetch = vi.fn(() => Promise.resolve(response(snapshot([tagged, commit('other')])))) as typeof fetch
    await useGitGraphStore.getState().open('ws')

    for (const query of ['grace', 'compiler', 'abcdef', 'v1']) {
      useGitGraphStore.getState().setSearchText('ws', query)
      expect(useGitGraphStore.getState().workspaces.ws.searchMatches).toEqual(['abcdef123'])
    }
    useGitGraphStore.getState().setSearchText('ws', 'example.com')
    expect(useGitGraphStore.getState().workspaces.ws.searchMatches).toEqual([])
    useGitGraphStore.getState().nextSearchMatch('ws')
    expect(useGitGraphStore.getState().workspaces.ws.activeSearchMatch).toBe(-1)
  })

  it('ignores stale snapshot and detail responses', async () => {
    const oldSnapshot = deferred<Response>()
    const newSnapshot = deferred<Response>()
    const oldDetail = deferred<Response>()
    const newDetail = deferred<Response>()
    global.fetch = vi.fn()
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(newSnapshot.promise)
      .mockReturnValueOnce(oldDetail.promise)
      .mockReturnValueOnce(newDetail.promise) as typeof fetch

    const first = useGitGraphStore.getState().refresh('ws')
    const second = useGitGraphStore.getState().refresh('ws')
    newSnapshot.resolve(response(snapshot([commit('new', { isHead: true })])))
    await second
    oldSnapshot.resolve(response(snapshot([commit('old', { isHead: true })])))
    await first
    expect(useGitGraphStore.getState().workspaces.ws.snapshot?.commits[0].hash).toBe('new')

    const firstDetail = useGitGraphStore.getState().selectCommit('ws', 'old')
    const secondDetail = useGitGraphStore.getState().selectCommit('ws', 'new')
    newDetail.resolve(response({ hash: 'new' } as GitGraphCommitDetail))
    await secondDetail
    oldDetail.resolve(response({ hash: 'old' } as GitGraphCommitDetail))
    await firstDetail
    expect(useGitGraphStore.getState().workspaces.ws.detail?.hash).toBe('new')
  })

  it('preserves a valid selection and falls back to HEAD then first visible commit', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response(snapshot([commit('keep'), commit('head', { isHead: true })])))
      .mockResolvedValueOnce(response(snapshot([commit('head2', { isHead: true }), commit('first')])))
      .mockResolvedValueOnce(response(snapshot([commit('first')], false))) as typeof fetch

    await useGitGraphStore.getState().open('ws')
    useGitGraphStore.setState((state) => ({
      workspaces: {
        ...state.workspaces,
        ws: { ...state.workspaces.ws, selectedCommitHash: 'keep' },
      },
    }))
    await useGitGraphStore.getState().refresh('ws')
    expect(useGitGraphStore.getState().workspaces.ws.selectedCommitHash).toBe('head2')
    await useGitGraphStore.getState().refresh('ws')
    expect(useGitGraphStore.getState().workspaces.ws.selectedCommitHash).toBe('first')
  })

  it('invalidates an in-flight detail when refresh replaces the selection', async () => {
    const detailResponse = deferred<Response>()
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response(snapshot([commit('old', { isHead: true })])))
      .mockReturnValueOnce(detailResponse.promise)
      .mockResolvedValueOnce(response(snapshot([commit('new', { isHead: true })]))) as typeof fetch

    await useGitGraphStore.getState().open('ws')
    const detailRequest = useGitGraphStore.getState().selectCommit('ws', 'old')
    await useGitGraphStore.getState().refresh('ws')
    detailResponse.resolve(response({ hash: 'old' } as GitGraphCommitDetail))
    await detailRequest

    expect(useGitGraphStore.getState().workspaces.ws).toMatchObject({
      selectedCommitHash: 'new',
      detail: null,
      detailError: null,
      detailLoading: false,
    })
  })

  it('keeps graph snapshot usable when commit detail fails and retains tab-local navigation state', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response(snapshot([commit('head', { isHead: true })])))
      .mockResolvedValueOnce(response({ error: 'detail failed' }, false)) as typeof fetch
    await useGitGraphStore.getState().open('ws')
    useGitGraphStore.getState().setScrollAnchor('ws', 88)
    await useGitGraphStore.getState().selectCommit('ws', 'head')

    expect(useGitGraphStore.getState().workspaces.ws.snapshot?.commits).toHaveLength(1)
    expect(useGitGraphStore.getState().workspaces.ws).toMatchObject({
      selectedCommitHash: 'head', scrollAnchor: 88, detailError: 'detail failed', snapshotError: null,
    })
  })
})
