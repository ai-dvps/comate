import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRightPanelStore, type FileTab, type DiffTab } from './right-panel-store'

function resetStore() {
  useRightPanelStore.setState({
    activeListTab: 'files',
    openTabs: [],
    activeTabId: null,
  })
}

describe('right-panel-store', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    ) as unknown as typeof global.fetch
  })

  it('setActiveListTab updates the active list tab', () => {
    const { setActiveListTab } = useRightPanelStore.getState()
    setActiveListTab('git-changes')
    expect(useRightPanelStore.getState().activeListTab).toBe('git-changes')
  })

  it('openFile fetches content and adds a file tab', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: 'hello', isBinary: false }),
      }),
    ) as unknown as typeof global.fetch

    const { openFile } = useRightPanelStore.getState()
    await openFile('ws1', 'src/App.tsx', 'App.tsx')

    const state = useRightPanelStore.getState()
    expect(state.openTabs).toHaveLength(1)
    const tab = state.openTabs[0] as FileTab
    expect(tab.type).toBe('file')
    expect(tab.id).toBe('file:src/App.tsx')
    expect(tab.name).toBe('App.tsx')
    expect(tab.content).toBe('hello')
    expect(tab.isBinary).toBe(false)
    expect(state.activeTabId).toBe('file:src/App.tsx')
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws1/files/content?path=src%2FApp.tsx',
      expect.any(Object),
    )
  })

  it('opening the same file twice dedupes and activates the existing tab', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: 'hello', isBinary: false }),
      }),
    ) as unknown as typeof global.fetch

    const { openFile } = useRightPanelStore.getState()
    await openFile('ws1', 'src/App.tsx', 'App.tsx')
    await openFile('ws1', 'src/App.tsx', 'App.tsx')

    const state = useRightPanelStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.activeTabId).toBe('file:src/App.tsx')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('openDiff fetches compare and adds a diff tab', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            original: 'old',
            modified: 'new',
            isBinary: false,
            truncated: false,
            isDeleted: false,
          }),
      }),
    ) as unknown as typeof global.fetch

    const { openDiff } = useRightPanelStore.getState()
    await openDiff('ws1', {
      path: 'src/App.tsx',
      indexStatus: 'M',
      workingTreeStatus: ' ',
    })

    const state = useRightPanelStore.getState()
    expect(state.openTabs).toHaveLength(1)
    const tab = state.openTabs[0] as DiffTab
    expect(tab.type).toBe('diff')
    expect(tab.id).toBe('diff:src/App.tsx:M')
    expect(tab.statusCode).toBe('M')
    expect(tab.original).toBe('old')
    expect(tab.modified).toBe('new')
    expect(state.activeTabId).toBe('diff:src/App.tsx:M')
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws1/git-changes/compare?path=src%2FApp.tsx&staged=true',
      expect.any(Object),
    )
  })

  it('openDiff for an unstaged working tree change uses staged=false', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            original: 'old',
            modified: 'new',
            isBinary: false,
            truncated: false,
            isDeleted: false,
          }),
      }),
    ) as unknown as typeof global.fetch

    const { openDiff } = useRightPanelStore.getState()
    await openDiff('ws1', {
      path: 'src/App.tsx',
      indexStatus: ' ',
      workingTreeStatus: 'M',
    })

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('staged=false'),
      expect.any(Object),
    )
    const tab = useRightPanelStore.getState().openTabs[0]
    expect(tab.id).toBe('diff:src/App.tsx:M')
  })

  it('openDiff marks untracked files correctly', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            original: '',
            modified: 'new',
            isBinary: false,
            truncated: false,
            isDeleted: false,
          }),
      }),
    ) as unknown as typeof global.fetch

    const { openDiff } = useRightPanelStore.getState()
    await openDiff('ws1', {
      path: 'new.txt',
      indexStatus: '?',
      workingTreeStatus: '?',
    })

    const tab = useRightPanelStore.getState().openTabs[0] as DiffTab
    expect(tab.type).toBe('diff')
    expect(tab.isUntracked).toBe(true)
    expect(tab.statusCode).toBe('?')
  })

  it('closeTab removes the tab and activates the nearest remaining tab', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: 'hello', isBinary: false }),
      }),
    ) as unknown as typeof global.fetch

    const { openFile, closeTab } = useRightPanelStore.getState()
    await openFile('ws1', 'a.tsx', 'a.tsx')
    await openFile('ws1', 'b.tsx', 'b.tsx')
    await openFile('ws1', 'c.tsx', 'c.tsx')

    closeTab('file:b.tsx')

    const state = useRightPanelStore.getState()
    expect(state.openTabs).toHaveLength(2)
    expect(state.openTabs.map((t) => t.id)).toEqual(['file:a.tsx', 'file:c.tsx'])
    expect(state.activeTabId).toBe('file:c.tsx')
  })

  it('closeTab clears activeTabId when the last tab is closed', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: 'hello', isBinary: false }),
      }),
    ) as unknown as typeof global.fetch

    const { openFile, closeTab } = useRightPanelStore.getState()
    await openFile('ws1', 'a.tsx', 'a.tsx')
    closeTab('file:a.tsx')

    const state = useRightPanelStore.getState()
    expect(state.openTabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
  })

  it('clearTabs removes all tabs and resets activeTabId', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: 'hello', isBinary: false }),
      }),
    ) as unknown as typeof global.fetch

    const { openFile, clearTabs } = useRightPanelStore.getState()
    await openFile('ws1', 'a.tsx', 'a.tsx')
    await openFile('ws1', 'b.tsx', 'b.tsx')
    clearTabs()

    const state = useRightPanelStore.getState()
    expect(state.openTabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
  })

  it('selectTab activates a tab', () => {
    useRightPanelStore.setState({
      openTabs: [
        {
          type: 'file',
          id: 'file:x',
          path: 'x',
          name: 'x',
          content: '',
          isBinary: false,
        },
      ],
      activeTabId: null,
    })
    const { selectTab } = useRightPanelStore.getState()
    selectTab('file:x')
    expect(useRightPanelStore.getState().activeTabId).toBe('file:x')
  })
})
