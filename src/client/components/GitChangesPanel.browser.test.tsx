import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { userEvent } from '@vitest/browser/context'
import { I18nextProvider } from 'react-i18next'
import GitChangesPanel from './GitChangesPanel'
import i18n from '../i18n'
import '../index.css'

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

const rightPanelMock = vi.hoisted(() => ({
  openDiff: vi.fn(() => Promise.resolve()),
}))

vi.mock('../stores/context-tab-store', () => ({
  useContextTabStore: { getState: () => ({ openDiff: rightPanelMock.openDiff }) },
}))

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { activeWorkspaceId: string | null }) => unknown) =>
    selector ? selector({ activeWorkspaceId: 'ws1' }) : { activeWorkspaceId: 'ws1' },
}))

describe('GitChangesPanel browser', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    window.innerWidth = 1280
    gitChangesMock.state.statusItems = [
      { path: 'src/main.ts', indexStatus: ' ', workingTreeStatus: 'M' },
      { path: 'new.txt', indexStatus: '?', workingTreeStatus: '?' },
    ]
    gitChangesMock.state.statusLoading = false
    gitChangesMock.state.statusError = null
    gitChangesMock.state.viewMode = 'tree'
    window.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: gitChangesMock.state.statusItems }),
      }),
    ) as unknown as typeof window.fetch
  })

  it('keeps a large tree bounded while scrolling and navigating past the viewport', async () => {
    gitChangesMock.state.statusItems = Array.from({ length: 10000 }, (_, i) => ({
      path: `src/file-${String(i).padStart(5, '0')}.ts`, indexStatus: '?', workingTreeStatus: '?',
    }))
    renderWithI18n(<div style={{ height: 360, width: 400 }}><GitChangesPanel /></div>)
    const tree = screen.getByRole('tree')
    expect(screen.getAllByTestId('git-file-row').length).toBeLessThan(60)
    for (let i = 0; i < 40; i++) fireEvent.keyDown(tree, { key: 'ArrowDown' })
    await vi.waitFor(() => expect(tree.scrollTop).toBeGreaterThan(0))
    expect(tree.querySelector('[aria-selected="true"]')).toBeInTheDocument()
    tree.scrollTop = tree.scrollHeight
    fireEvent.scroll(tree)
    await vi.waitFor(() => expect(screen.getByText('file-09999.ts')).toBeInTheDocument())
    expect(screen.getAllByTestId('git-file-row').length).toBeLessThan(60)
    await userEvent.dblClick(screen.getByText('file-09999.ts'))
    expect(rightPanelMock.openDiff).toHaveBeenCalledWith('ws1', gitChangesMock.state.statusItems[9999], false)
  })

  it('double-clicking a modified file calls right-panel openDiff with workspace id and file', async () => {
    renderWithI18n(<GitChangesPanel />)

    const row = screen.getByText('main.ts').closest('[data-testid="git-file-row"]') as HTMLElement
    await userEvent.dblClick(row)

    await vi.waitFor(() => expect(rightPanelMock.openDiff).toHaveBeenCalledWith('ws1', {
      path: 'src/main.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
    }, false))
  })

  it('double-clicking an untracked file calls right-panel openDiff with workspace id and file', async () => {
    renderWithI18n(<GitChangesPanel />)

    const row = screen.getByText('new.txt').closest('[data-testid="git-file-row"]') as HTMLElement
    await userEvent.dblClick(row)

    await vi.waitFor(() => expect(rightPanelMock.openDiff).toHaveBeenCalledWith('ws1', {
      path: 'new.txt',
      indexStatus: '?',
      workingTreeStatus: '?',
    }, false))
  })
})
