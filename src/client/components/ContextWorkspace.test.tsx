import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ContextWorkspace from './ContextWorkspace'
import { useContextTabStore } from '../stores/context-tab-store'

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
vi.mock('./CodeMirrorFileViewer', () => ({
  default: ({ tab }: { tab: { path: string } }) => <div data-testid="file-viewer">{tab.path}</div>,
}))
vi.mock('./CodeMirrorDiffViewer', () => ({
  default: ({ tab }: { tab: { path: string } }) => <div data-testid="diff-viewer">{tab.path}</div>,
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
    render(
      <ContextWorkspace
        width={600}
        isCollapsed={false}
        onWidthChange={vi.fn()}
        workspaceId="ws-1"
        workspacePath="/workspace"
      />,
    )

    expect(screen.getByTestId('context-primary')).toBeInTheDocument()
    expect(screen.getByTestId('context-navigator')).toBeInTheDocument()
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument()
    expect(screen.getByTestId('git-changes-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse internal navigator' }))
    expect(screen.queryByTestId('context-navigator')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand internal navigator' })).toBeInTheDocument()
  })

  it('keeps Browser panes mounted but only exposes the active Session surface', () => {
    useContextTabStore.getState().openBrowser('session-a', 'ws-1')
    render(
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
})
