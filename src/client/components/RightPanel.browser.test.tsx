import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { userEvent } from '@vitest/browser/context'
import { I18nextProvider } from 'react-i18next'
import RightPanel from './RightPanel'
import { useRightPanelStore } from '../stores/right-panel-store'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { activeWorkspaceId: string | null; workspaces: unknown[] }) => unknown) =>
    selector
      ? selector({
          activeWorkspaceId: 'ws1',
          workspaces: [{ id: 'ws1', name: 'Test', folderPath: '/workspace' }],
        })
      : { activeWorkspaceId: 'ws1', workspaces: [{ id: 'ws1', name: 'Test', folderPath: '/workspace' }] },
}))

vi.mock('../stores/files-store', () => ({
  useFiles: () => ({
    results: [],
    loading: false,
    error: undefined,
    truncated: false,
    search: vi.fn(),
    clear: vi.fn(),
  }),
}))

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
  return { state, useGitChanges, notify }
})

vi.mock('../stores/git-changes-store', () => ({
  useGitChangesStore: {
    getState: () => ({
      setPanelVisible: vi.fn(),
      setActiveWorkspaceId: vi.fn(),
      refresh: vi.fn(),
      setViewMode: vi.fn(),
    }),
  },
  useGitChanges: gitChangesMock.useGitChanges,
}))

vi.mock('@uiw/react-codemirror', () => ({
  default: function CodeMirrorMock({ value, className }: { value?: string; className?: string }) {
    return (
      <pre data-testid="codemirror" className={className}>
        {value}
      </pre>
    )
  },
}))

vi.mock('@codemirror/merge', () => ({
  unifiedMergeView: vi.fn(() => []),
  MergeView: vi.fn(() => ({ destroy: vi.fn() })),
}))

function resetRightPanelStore() {
  useRightPanelStore.setState({
    activeListTab: 'files',
    openTabs: [],
    activeTabId: null,
  })
}

describe('RightPanel browser', () => {
  beforeEach(() => {
    cleanup()
    resetRightPanelStore()
    vi.clearAllMocks()
    gitChangesMock.state.statusItems = []
    gitChangesMock.state.statusLoading = false
    gitChangesMock.state.statusError = null
    gitChangesMock.state.viewMode = 'tree'
    gitChangesMock.state.isWatcherAvailable = true

    window.fetch = vi.fn((url: string) => {
      if (url.includes('/files/content')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ content: 'file content', isBinary: false }),
        })
      }
      if (url.includes('/git-changes/compare')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              original: 'original content',
              modified: 'modified content',
              isBinary: false,
              truncated: false,
              isDeleted: false,
            }),
        })
      }
      if (url.includes('/git-changes')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: gitChangesMock.state.statusItems }),
        })
      }
      if (url.includes('/files')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ nodes: [{ name: 'App.tsx', type: 'file' }] }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }) as unknown as typeof window.fetch
  })

  it('opens a CodeMirror file tab when a file is double-clicked in the Files tab', async () => {
    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
        workspacePath="/workspace"
      />,
    )

    await vi.waitFor(() => {
      expect(screen.getByText('App.tsx')).toBeInTheDocument()
    })

    await userEvent.dblClick(screen.getByText('App.tsx'))

    await vi.waitFor(() => {
      expect(screen.getByRole('tab', { name: /App.tsx/ })).toBeInTheDocument()
    })
    expect(screen.getByTestId('codemirror')).toHaveTextContent('file content')
    expect(screen.queryByText('Open a file or change to view it')).not.toBeInTheDocument()
  })

  it('opens a diff tab when a git change is double-clicked in the Git Changes tab', async () => {
    gitChangesMock.state.statusItems = [{ path: 'src/main.ts', indexStatus: ' ', workingTreeStatus: 'M' }]

    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
        workspacePath="/workspace"
      />,
    )

    await userEvent.click(screen.getByTestId('right-panel-git-tab'))

    await vi.waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument()
    })

    const row = screen.getByText('main.ts').closest('[data-testid="git-file-row"]') as HTMLElement
    await userEvent.dblClick(row)

    await vi.waitFor(() => {
      expect(screen.getByRole('tab', { name: /main.ts/ })).toBeInTheDocument()
    })
    const tab = screen.getByRole('tab', { name: /main.ts/ })
    expect(tab).toHaveTextContent('M')
    expect(screen.getByTestId('codemirror')).toHaveTextContent('modified content')
  })
})
