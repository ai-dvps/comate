import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChangedFilesPanel from './ChangedFilesPanel'
import { ToolRendererProvider } from './tool-renderers/ToolRendererContext'
import { useChangedFilesExistence } from '../hooks/use-changed-files-existence'
import type { TouchedFileEntry } from '../stores/chat-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const mockChatStore = {
  touchedFiles: {} as Record<string, TouchedFileEntry[]>,
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockChatStore) => unknown) => selector(mockChatStore),
}))

const mockWorkspaceStore = {
  workspaces: [{ id: 'ws1', folderPath: '/ws' }],
  activeWorkspaceId: 'ws1' as string | null,
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (state: typeof mockWorkspaceStore) => unknown) =>
    selector(mockWorkspaceStore),
}))

vi.mock('../hooks/use-changed-files-existence', () => ({
  useChangedFilesExistence: vi.fn(() => new Set<string>()),
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ chatFontSize: 14 }),
}))

const existenceMock = vi.mocked(useChangedFilesExistence)

function entry(
  path: string,
  status: TouchedFileEntry['status'] = 'modified',
  lastTouchedAt = 0,
): TouchedFileEntry {
  return { path, status, lastTouchedAt }
}

function panelElement(
  sessionId: string,
  onOpenFile: (path: string, name: string) => void = () => {},
) {
  return (
    <ToolRendererProvider value={{ workspacePath: '/ws', onOpenFile }}>
      <ChangedFilesPanel sessionId={sessionId} />
    </ToolRendererProvider>
  )
}

describe('ChangedFilesPanel', () => {
  beforeEach(() => {
    mockChatStore.touchedFiles = {}
    mockWorkspaceStore.workspaces = [{ id: 'ws1', folderPath: '/ws' }]
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    existenceMock.mockReturnValue(new Set<string>())
    existenceMock.mockClear()
    cleanup()
  })

  it('renders nothing when the session has no touched files (AE4)', () => {
    const { container, rerender } = render(panelElement('s1'))
    expect(container.firstChild).toBeNull()

    mockChatStore.touchedFiles.s1 = []
    rerender(panelElement('s1'))
    expect(container.firstChild).toBeNull()
  })

  it('renders expanded by default; collapsing shows the title and count', async () => {
    mockChatStore.touchedFiles.s1 = [
      entry('/ws/src/a.ts', 'modified', 2),
      entry('/ws/b.md', 'created', 1),
    ]
    render(panelElement('s1'))

    // Expanded by default: rows visible without clicking.
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('b.md')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'changedFilesTitle' }))

    expect(screen.queryByText('a.ts')).not.toBeInTheDocument()
    expect(screen.queryByText('b.md')).not.toBeInTheDocument()
    expect(screen.getByText('changedFilesTitle')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders badge, dimmed directory, and file name in last-touch order', () => {
    mockChatStore.touchedFiles.s1 = [
      entry('/ws/src/newest.ts', 'created', 200),
      entry('/ws/lib/deep/older.ts', 'modified', 100),
    ]
    const { container } = render(panelElement('s1'))

    const rows = container.querySelectorAll('li')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('newest.ts')
    expect(rows[1].textContent).toContain('older.ts')

    expect(within(rows[0]).getByText('A')).toHaveClass('bg-success/10')
    expect(within(rows[1]).getByText('M')).toHaveClass('bg-warning/10')

    expect(within(rows[0]).getByText('src/')).toHaveClass('text-text-tertiary')
    expect(within(rows[1]).getByText('lib/deep/')).toHaveClass('text-text-tertiary')
  })

  it('prioritizes the basename, truncates bounded, and shows the full relative path on hover', () => {
    mockChatStore.touchedFiles.s1 = [
      entry('/ws/src/client/components/tool-renderers/FilePath.tsx', 'modified', 100),
    ]
    const { container } = render(panelElement('s1'))

    const pathSpan = container.querySelector('li span[title$="FilePath.tsx"]')
    expect(pathSpan).toHaveAttribute(
      'title',
      'src/client/components/tool-renderers/FilePath.tsx',
    )
    const fileNameEl = screen.getByText('FilePath.tsx')
    expect(fileNameEl.className).toContain('truncate')
    expect(fileNameEl.className).not.toContain('shrink-0')
    const dirEl = screen.getByText('src/client/components/tool-renderers/')
    expect(dirEl.className).toContain('[direction:rtl]')
  })

  it('drops stored paths outside the workspace folder (KTD6)', () => {
    mockChatStore.touchedFiles.s1 = [
      entry('/ws/src/a.ts'),
      entry('/etc/outside.ts'),
    ]
    render(panelElement('s1'))

    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.queryByText('outside.ts')).not.toBeInTheDocument()
  })

  it('renders nothing when every stored path is outside the workspace', () => {
    mockChatStore.touchedFiles.s1 = [entry('/etc/outside.ts')]
    const { container } = render(panelElement('s1'))
    expect(container.firstChild).toBeNull()
  })

  it('strikes through a missing file and disables its open action (AE2 display half)', () => {
    mockChatStore.touchedFiles.s1 = [
      entry('/ws/gone.ts', 'created'),
      entry('/ws/here.ts', 'modified'),
    ]
    existenceMock.mockReturnValue(new Set(['/ws/gone.ts']))
    render(panelElement('s1'))

    const goneRow = screen.getByText('gone.ts').closest('li')
    expect(goneRow).not.toBeNull()
    expect(screen.getByText('gone.ts')).toHaveClass('line-through')
    expect(within(goneRow as HTMLElement).getByText('D')).toHaveClass('bg-destructive/10')
    expect(within(goneRow as HTMLElement).getByRole('button')).toBeDisabled()

    const hereRow = screen.getByText('here.ts').closest('li') as HTMLElement
    expect(screen.getByText('here.ts')).not.toHaveClass('line-through')
    expect(within(hereRow).getByRole('button')).toBeEnabled()
  })

  it('calls the open handler with the workspace-relative path on open', async () => {
    mockChatStore.touchedFiles.s1 = [entry('/ws/src/a.ts')]
    const onOpenFile = vi.fn()
    render(panelElement('s1', onOpenFile))

    const row = screen.getByText('a.ts').closest('li') as HTMLElement
    const user = userEvent.setup()
    await user.click(within(row).getByRole('button'))

    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts', 'a.ts')
  })

  it('resets the collapse state and shows the new list on session switch', async () => {
    mockChatStore.touchedFiles.s1 = [entry('/ws/one.ts')]
    mockChatStore.touchedFiles.s2 = [entry('/ws/two.ts')]
    const { rerender } = render(panelElement('s1'))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'changedFilesTitle' }))
    expect(screen.queryByText('one.ts')).not.toBeInTheDocument()

    rerender(panelElement('s2'))

    // Expanded again after the switch, showing the new session's list.
    expect(screen.getByText('two.ts')).toBeInTheDocument()
    expect(screen.queryByText('one.ts')).not.toBeInTheDocument()
  })

  it('caps the list height and scrolls internally when entries exceed it', () => {
    mockChatStore.touchedFiles.s1 = Array.from({ length: 30 }, (_, i) =>
      entry(`/ws/dir/file${i}.ts`, 'modified', i),
    )
    const { container } = render(panelElement('s1'))

    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    expect((scroller as HTMLElement).className).toContain('max-h-64')
    expect(screen.getByText('file29.ts')).toBeInTheDocument()
  })

  it('runs existence checks only while expanded', async () => {
    mockChatStore.touchedFiles.s1 = [entry('/ws/src/a.ts')]
    render(panelElement('s1'))

    expect(existenceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, workspaceId: 'ws1', folderPath: '/ws' }),
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'changedFilesTitle' }))

    expect(existenceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    )
  })
})
