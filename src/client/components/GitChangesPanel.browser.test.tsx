import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { useState } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { userEvent } from '@vitest/browser/context'
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
      state.diffContent = { diff: 'browser diff', isBinary: false, truncated: false }
      notify()
    }),
    clearDiff: vi.fn(() => {
      state.selectedFile = null
      state.diffContent = null
      notify()
    }),
    setViewMode: vi.fn(),
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

function TestHarness() {
  const [collapsed, setCollapsed] = useState(true)
  return (
    <GitChangesPanel
      width={320}
      isCollapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      onWidthChange={() => {}}
      onOpenDiff={() => {}}
    />
  )
}

describe('GitChangesPanel browser', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    window.innerWidth = 1280
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: ' ', workingTreeStatus: 'M' },
      { path: 'new.txt', indexStatus: '?', workingTreeStatus: '?' },
    ]
    gitChangesMock.state.selectedFile = null
    gitChangesMock.state.diffContent = null
    gitChangesMock.state.statusLoading = false
    gitChangesMock.state.statusError = null
    gitChangesMock.state.viewMode = 'tree'
    gitChangesMock.state.isWatcherAvailable = true
    window.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: gitChangesMock.state.statusItems }),
      }),
    ) as unknown as typeof window.fetch
  })

  it('toggling the panel shows the file list', async () => {
    renderWithI18n(<TestHarness />)

    expect(screen.queryByRole('tree')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('git-changes-toggle'))

    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('new.txt')).toBeInTheDocument()
  })

  it('double-clicking a modified file calls onOpenDiff with path, name and statuses', async () => {
    const onOpenDiff = vi.fn()
    renderWithI18n(<GitChangesPanel
      width={320}
      isCollapsed={false}
      onToggleCollapse={() => {}}
      onWidthChange={() => {}}
      onOpenDiff={onOpenDiff}
    />)

    const row = screen.getByText('main.ts').closest('[data-testid="git-file-row"]') as HTMLElement
    await userEvent.dblClick(row)

    await vi.waitFor(() => expect(onOpenDiff).toHaveBeenCalledWith('src/main.ts', 'main.ts', ' ', 'M'))
  })

  it('double-clicking an untracked file calls onOpenDiff with path, name and statuses', async () => {
    const onOpenDiff = vi.fn()
    renderWithI18n(<GitChangesPanel
      width={320}
      isCollapsed={false}
      onToggleCollapse={() => {}}
      onWidthChange={() => {}}
      onOpenDiff={onOpenDiff}
    />)

    const row = screen.getByText('new.txt').closest('[data-testid="git-file-row"]') as HTMLElement
    await userEvent.dblClick(row)

    await vi.waitFor(() => expect(onOpenDiff).toHaveBeenCalledWith('new.txt', 'new.txt', '?', '?'))
  })
})
