import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { ReactNode } from 'react'
import i18n from '../i18n'
import ContextWorkspace from './ContextWorkspace'
import { useContextTabStore } from '../stores/context-tab-store'

function renderWorkspace(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

vi.mock('./FileExplorer', () => ({
  default: ({ onFilePreview, onFileClick }: {
    onFilePreview: (path: string, name: string) => void
    onFileClick: (path: string, name: string) => void
  }) => (
    <div data-testid="file-explorer">
      <button onClick={() => onFilePreview('preview.ts', 'preview.ts')}>Preview file</button>
      <button onClick={() => onFileClick('durable.ts', 'durable.ts')}>Open file</button>
    </div>
  ),
}))

vi.mock('./GitChangesPanel', () => ({ default: () => <div data-testid="git-changes-panel" /> }))
vi.mock('./git-graph/GitGraphPanel', () => ({
  default: () => <div data-testid="git-graph-container">Git Graph browser</div>,
}))
vi.mock('./CodeMirrorFileViewer', () => ({
  default: ({ tab, headerActions }: { tab: { path: string }; headerActions?: ReactNode }) => (
    <div data-testid="file-viewer">
      {tab.path}
      {headerActions}
    </div>
  ),
}))
vi.mock('./CodeMirrorDiffViewer', () => ({
  default: ({ tab, width, headerActions }: {
    tab: { path: string; original?: string; modified?: string; isBinary?: boolean; truncated?: boolean; isDeleted?: boolean }
    width: number
    headerActions?: ReactNode
  }) => (
    <div
      data-testid="diff-viewer"
      data-width={width}
      data-original={tab.original}
      data-modified={tab.modified}
      data-binary={tab.isBinary}
      data-truncated={tab.truncated}
      data-deleted={tab.isDeleted}
    >
      {tab.path}
      {headerActions}
    </div>
  ),
}))
vi.mock('./browser/BrowserPane', () => ({
  default: ({ workspaceId, surfaceVisible }: { workspaceId: string; surfaceVisible: boolean }) => (
    <div data-testid={`browser-${workspaceId}`} data-visible={surfaceVisible} />
  ),
}))

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (state: { openWorkspaceIds: string[] }) => unknown) => selector({
    openWorkspaceIds: ['ws-1', 'ws-2'],
  }),
}))

describe('ContextWorkspace', () => {
  beforeEach(() => {
    useContextTabStore.getState().reset()
    useContextTabStore.getState().setContext('ws-1', 'session-a')
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ content: 'content', isBinary: false }),
    })) as unknown as typeof global.fetch
  })

  it('renders File content left and its collapsible tree on the internal right', () => {
    useContextTabStore.getState().openFileWorkspace('ws-1')
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
        workspacePath="/workspace"
      />,
    )

    expect(screen.getByTestId('context-primary')).toBeInTheDocument()
    expect(screen.getByTestId('context-workspace')).toHaveClass('border-l')
    expect(screen.getByTestId('context-navigator')).toBeInTheDocument()
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument()
    expect(screen.getByTestId('git-changes-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse internal navigator' }))
    expect(screen.queryByTestId('context-navigator')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand internal navigator' })).toBeInTheDocument()
  })

  it('renders the navigator toggle inside the viewer header when a file is open', async () => {
    await useContextTabStore.getState().openFile('ws-1', 'src/app.ts', 'app.ts')
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
        workspacePath="/workspace"
      />,
    )

    // Single toggle, rendered inside the viewer header instead of a floating overlay.
    const toggle = screen.getByTestId('navigator-toggle')
    expect(toggle.closest('[data-testid="file-viewer"]')).not.toBeNull()
    expect(screen.getAllByTestId('navigator-toggle')).toHaveLength(1)
    expect(toggle).toHaveAttribute('aria-label', 'Collapse internal navigator')

    fireEvent.click(toggle)
    expect(screen.queryByTestId('context-navigator')).not.toBeInTheDocument()
    expect(screen.getByTestId('navigator-toggle')).toHaveAttribute('aria-label', 'Expand internal navigator')
    expect(screen.getAllByTestId('navigator-toggle')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('navigator-toggle'))
    expect(screen.getByTestId('context-navigator')).toBeInTheDocument()
    expect(screen.getByTestId('navigator-toggle')).toHaveAttribute('aria-label', 'Collapse internal navigator')
  })

  it('animates the navigator column width when toggling the tree', async () => {
    await useContextTabStore.getState().openFile('ws-1', 'src/app.ts', 'app.ts')
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
        workspacePath="/workspace"
      />,
    )

    const navigator = screen.getByTestId('context-navigator')
    expect(navigator).toHaveClass('transition-[width,border-width,visibility]')
    expect(navigator).toHaveClass('duration-200')

    fireEvent.click(screen.getByTestId('navigator-toggle'))
    expect(screen.queryByTestId('context-navigator')).not.toBeInTheDocument()
  })

  it('removes the outer divider when the context workspace is collapsed', () => {
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
      />,
    )

    expect(screen.getByTestId('context-workspace')).not.toHaveClass('border-l')
  })

  it('keeps Browser panes mounted but only exposes the active Session surface', () => {
    useContextTabStore.getState().openBrowser('session-a', 'ws-1')
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
      />,
    )

    expect(screen.getByTestId('browser-ws-1')).toHaveAttribute('data-visible', 'true')
    expect(screen.getByTestId('browser-ws-2')).toHaveAttribute('data-visible', 'false')
  })

  it('passes the primary content width to the Diff viewer', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ original: 'before', modified: 'after' }),
    })) as unknown as typeof global.fetch
    await useContextTabStore.getState().openDiff('ws-1', {
      path: 'changed.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
    })

    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
      />,
    )

    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-width', '340')
  })

  it('renders Git Graph as primary content without a File or Changes navigator', () => {
    useContextTabStore.getState().openGitGraph('ws-1')
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
      />,
    )

    expect(screen.getByTestId('git-graph-container')).toHaveTextContent('Git Graph browser')
    expect(screen.queryByTestId('context-navigator')).not.toBeInTheDocument()
  })

  it('adapts a historical text Diff to the existing viewer with explicit states', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        commitHash: 'commit-a', baseHash: 'base-a', path: 'deleted.ts', status: 'D',
        original: 'before', modified: '', isBinary: false, isTextComparable: true,
        truncated: true, isDeleted: true,
      }),
    })) as unknown as typeof global.fetch
    await useContextTabStore.getState().openCommitDiff('ws-1', 'commit-a', 'base-a', {
      path: 'deleted.ts', status: 'D', additions: 0, deletions: 1,
      isBinary: false, isGitlink: false,
    })
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
      />,
    )

    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-original', 'before')
    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-modified', '')
    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-truncated', 'true')
    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-deleted', 'true')
    expect(screen.queryByTestId('context-navigator')).not.toBeInTheDocument()
  })

  it('presents Gitlink changes explicitly instead of sending them to a text Diff viewer', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        commitHash: 'commit-a', baseHash: 'base-a', path: 'vendor/module', status: 'M',
        original: '', modified: '', isBinary: false, isTextComparable: false,
        uncomparableReason: 'gitlink', truncated: false, isDeleted: false,
      }),
    })) as unknown as typeof global.fetch
    await useContextTabStore.getState().openCommitDiff('ws-1', 'commit-a', 'base-a', {
      path: 'vendor/module', status: 'M', additions: null, deletions: null,
      isBinary: false, isGitlink: true,
    })
    renderWorkspace(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
      />,
    )

    expect(screen.getByTestId('gitlink-diff-placeholder')).toHaveTextContent('submodule pointer')
    expect(screen.queryByTestId('diff-viewer')).not.toBeInTheDocument()
  })
})
