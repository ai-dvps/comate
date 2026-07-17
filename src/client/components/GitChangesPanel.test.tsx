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
    selectedFile: null as { path: string; indexStatus: string; workingTreeStatus: string; staged: boolean } | null,
    diffContent: null as { diff: string; isBinary: boolean; truncated: boolean } | null,
    diffLoading: false,
    diffError: null as string | null,
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
    openDiff: vi.fn((_workspaceId: string, file: { path: string; indexStatus: string; workingTreeStatus: string }) => {
      state.selectedFile = {
        ...file,
        staged: file.indexStatus !== ' ' && file.indexStatus !== '?',
      }
      notify()
    }),
    loadDiff: vi.fn(async () => {
      state.diffContent = { diff: 'test diff', isBinary: false, truncated: false }
      notify()
    }),
    clearDiff: vi.fn(() => {
      state.selectedFile = null
      state.diffContent = null
      notify()
    }),
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

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { activeWorkspaceId: string | null }) => unknown) =>
    selector ? selector({ activeWorkspaceId: 'ws1' }) : { activeWorkspaceId: 'ws1' },
}))

vi.mock('./GitDiffView', () => ({
  default: () => <div data-testid="git-diff-view" />,
}))

const DEFAULT_PROPS = {
  width: 320,
  isCollapsed: false,
  onToggleCollapse: vi.fn(),
  onWidthChange: vi.fn(),
}

describe('GitChangesPanel', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    gitChangesMock.state.statusItems = []
    gitChangesMock.state.selectedFile = null
    gitChangesMock.state.diffContent = null
    gitChangesMock.state.diffLoading = false
    gitChangesMock.state.diffError = null
    gitChangesMock.state.statusLoading = false
    gitChangesMock.state.statusError = null
    gitChangesMock.state.viewMode = 'tree'
    gitChangesMock.state.isWatcherAvailable = true
  })

  it('renders a loading skeleton while status is loading', () => {
    gitChangesMock.state.statusLoading = true
    renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} />)

    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument()
  })

  it('renders an empty state when there are no changes', () => {
    renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} />)

    expect(screen.getByTestId('git-empty-state')).toBeInTheDocument()
  })

  it('shows the untracked group above the changed files tree', () => {
    gitChangesMock.state.statusItems = [
      { path: 'new.txt', indexStatus: '?', workingTreeStatus: '?' },
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: ' ' },
    ]

    const { container } = renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} />)

    const untrackedGroup = screen.getByTestId('git-untracked-group')
    const changedTree = screen.getByTestId('git-changed-tree')
    expect(untrackedGroup).toBeInTheDocument()
    expect(changedTree).toBeInTheDocument()
    expect(container.textContent?.indexOf('new.txt')).toBeLessThan(
      container.textContent?.indexOf('src/main.ts') ?? 0,
    )
  })

  it('toggles between tree and flat views', async () => {
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: ' ' },
      { path: 'src/lib/util.ts', indexStatus: 'A', workingTreeStatus: ' ' },
    ]

    renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} />)

    expect(screen.getByText('src')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('git-flat-view-button'))

    await waitFor(() => {
      expect(screen.queryByText('src')).not.toBeInTheDocument()
      expect(screen.getByText('src/main.ts')).toBeInTheDocument()
      expect(screen.getByText('src/lib/util.ts')).toBeInTheDocument()
    })
  })

  it('calls openDiff and renders GitDiffView on double-click', async () => {
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: 'M', workingTreeStatus: ' ' },
    ]

    renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} />)

    const row = screen.getByTestId('git-file-row')
    fireEvent.doubleClick(row)

    await waitFor(() => expect(gitChangesMock.actions.openDiff).toHaveBeenCalledWith('ws1', {
      path: 'src/main.ts',
      indexStatus: 'M',
      workingTreeStatus: ' ',
    }))
    expect(gitChangesMock.actions.loadDiff).toHaveBeenCalledWith('ws1')
    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument()
  })

  it('calls onToggleCollapse when the collapsed rail icon is clicked', () => {
    renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} isCollapsed={true} />)

    fireEvent.click(screen.getByTestId('git-changes-toggle'))
    expect(DEFAULT_PROPS.onToggleCollapse).toHaveBeenCalledTimes(1)
  })

  it('shows a spinner while refreshing and surfaces an error on failure', () => {
    gitChangesMock.state.statusLoading = true
    const { rerender } = renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} />)

    expect(screen.getByTestId('git-refresh-button').querySelector('.animate-spin')).toBeInTheDocument()

    gitChangesMock.state.statusLoading = false
    gitChangesMock.state.statusError = 'network error'
    rerender(<GitChangesPanel {...DEFAULT_PROPS} />)

    expect(screen.getByText(/network error/)).toBeInTheDocument()
  })

  it('shows the watcher unavailable warning', () => {
    gitChangesMock.state.isWatcherAvailable = false
    renderWithI18n(<GitChangesPanel {...DEFAULT_PROPS} />)

    expect(screen.getByText('Auto-refresh unavailable')).toBeInTheDocument()
  })
})
