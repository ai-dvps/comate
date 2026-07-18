import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import GitChangesPanel from './GitChangesPanel'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const gitChangesMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    statusItems: [] as { path: string; indexStatus: string; workingTreeStatus: string }[],
    statusLoading: false,
    statusError: null as string | null,
    viewMode: 'tree' as 'tree' | 'flat',
    isWatcherAvailable: true,
  }
  function notify() {
    listeners.forEach((l) => l())
  }
  function useGitChanges() {
    const [, forceRender] = React.useReducer((x: number) => x + 1, 0)
    React.useEffect(() => {
      listeners.add(forceRender)
      return () => {
        listeners.delete(forceRender)
      }
    }, [])
    return state
  }
  const actions = {
    refresh: vi.fn(),
    setViewMode: vi.fn((_workspaceId: string, mode: 'tree' | 'flat') => {
      state.viewMode = mode
      notify()
    }),
    setPanelVisible: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  }
  return { state, actions, useGitChanges, notify }
})

vi.mock('../stores/git-changes-store', () => ({
  useGitChangesStore: { getState: () => gitChangesMock.actions },
  useGitChanges: gitChangesMock.useGitChanges,
}))

const rightPanelMock = vi.hoisted(() => ({
  openDiff: vi.fn(() => Promise.resolve()),
}))

vi.mock('../stores/right-panel-store', () => ({
  useRightPanelStore: { getState: () => ({ openDiff: rightPanelMock.openDiff }) },
}))

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { activeWorkspaceId: string | null }) => unknown) =>
    selector ? selector({ activeWorkspaceId: 'ws1' }) : { activeWorkspaceId: 'ws1' },
}))

describe('GitChangesPanel', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    gitChangesMock.state.statusItems = []
    gitChangesMock.state.statusLoading = false
    gitChangesMock.state.statusError = null
    gitChangesMock.state.viewMode = 'tree'
    gitChangesMock.state.isWatcherAvailable = true
  })

  it('renders a loading skeleton while status is loading', () => {
    gitChangesMock.state.statusLoading = true
    renderWithI18n(<GitChangesPanel />)

    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument()
  })

  it('renders an empty state when there are no changes', () => {
    renderWithI18n(<GitChangesPanel />)

    expect(screen.getByTestId('git-empty-state')).toBeInTheDocument()
  })

  it('shows the changed files tree above the untracked group', () => {
    gitChangesMock.state.statusItems = [
      { path: 'new.txt', indexStatus: '?', workingTreeStatus: '?' },
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: ' ' },
    ]

    const { container } = renderWithI18n(<GitChangesPanel />)

    const untrackedGroup = screen.getByTestId('git-untracked-group')
    const changedTree = screen.getByTestId('git-changed-tree')
    expect(untrackedGroup).toBeInTheDocument()
    expect(changedTree).toBeInTheDocument()
    expect(container.textContent?.indexOf('main.ts')).toBeLessThan(
      container.textContent?.indexOf('new.txt') ?? 0,
    )
  })

  it('toggles between tree and flat views', async () => {
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: ' ' },
      { path: 'src/util.ts', indexStatus: 'A', workingTreeStatus: ' ' },
    ]

    renderWithI18n(<GitChangesPanel />)

    // Tree view: folder headers and file names only.
    expect(screen.getByText('src')).toBeInTheDocument()
    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('util.ts')).toBeInTheDocument()
    expect(screen.queryByText('src/main.ts')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('git-flat-view-button'))

    await waitFor(() => {
      // Flat view: full paths, no folder headers.
      expect(screen.queryByText('src')).not.toBeInTheDocument()
      expect(screen.getByText('src/main.ts')).toBeInTheDocument()
      expect(screen.getByText('src/util.ts')).toBeInTheDocument()
    })
  })

  it('organizes untracked files into the tree in tree view', async () => {
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: ' ' },
      { path: 'newdir/a.txt', indexStatus: '?', workingTreeStatus: '?' },
    ]

    renderWithI18n(<GitChangesPanel />)

    // Tree view: untracked files are grouped below changed files and shown as a tree.
    const untrackedGroup = screen.getByTestId('git-untracked-group')
    expect(untrackedGroup).toBeInTheDocument()
    expect(screen.getByText('newdir')).toBeInTheDocument()
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.queryByText('newdir/a.txt')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('git-flat-view-button'))

    await waitFor(() => {
      // Flat view: untracked files are shown as full paths in the top group.
      expect(screen.getByText('newdir/a.txt')).toBeInTheDocument()
    })
  })

  it('calls right-panel openDiff with workspace id and file on double-click', async () => {
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: ' ' },
    ]

    renderWithI18n(<GitChangesPanel />)

    const row = screen.getByTestId('git-file-row')
    fireEvent.doubleClick(row)

    await waitFor(() =>
      expect(rightPanelMock.openDiff).toHaveBeenCalledWith('ws1', {
        path: 'src/main.ts',
        indexStatus: 'M',
        workingTreeStatus: ' ',
      }, true),
    )
  })

  it('shows staged and unstaged entries for a file with changes in both sides', async () => {
    gitChangesMock.state.viewMode = 'flat'
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: 'M' },
    ]

    renderWithI18n(<GitChangesPanel />)

    const rows = screen.getAllByTestId('git-file-row')
    // An MM file yields two entries so both the staged and unstaged diffs open.
    expect(rows).toHaveLength(2)

    fireEvent.doubleClick(rows[0])
    fireEvent.doubleClick(rows[1])

    await waitFor(() => {
      expect(rightPanelMock.openDiff).toHaveBeenCalledWith(
        'ws1',
        { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: 'M' },
        true,
      )
      expect(rightPanelMock.openDiff).toHaveBeenCalledWith(
        'ws1',
        { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: 'M' },
        false,
      )
    })
  })

  it('shows a spinner while refreshing and surfaces an error on failure', () => {
    gitChangesMock.state.statusLoading = true
    const { rerender } = renderWithI18n(<GitChangesPanel />)

    expect(screen.getByTestId('git-refresh-button').querySelector('.animate-spin')).toBeInTheDocument()

    gitChangesMock.state.statusLoading = false
    gitChangesMock.state.statusError = 'network error'
    rerender(<GitChangesPanel />)

    expect(screen.getByText(/network error/)).toBeInTheDocument()
  })

  it('shows the watcher unavailable warning', () => {
    gitChangesMock.state.isWatcherAvailable = false
    renderWithI18n(<GitChangesPanel />)

    expect(screen.getByText('Auto-refresh unavailable')).toBeInTheDocument()
  })
})
