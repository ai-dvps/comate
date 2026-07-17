import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import FileExplorer from './FileExplorer'
import type { UseFilesResult } from '../stores/files-store'

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

const mockWorkspaceStore = {
  activeWorkspaceId: 'ws-1' as string | null,
  workspaces: [{ id: 'ws-1', name: 'Project', folderPath: '/project' }],
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: typeof mockWorkspaceStore) => unknown) =>
    selector ? selector(mockWorkspaceStore) : mockWorkspaceStore,
}))

let mockUseFilesResult: UseFilesResult = {
  results: [],
  loading: false,
  error: undefined,
  truncated: false,
  search: vi.fn(),
  clear: vi.fn(),
}

vi.mock('../stores/files-store', () => ({
  useFiles: () => mockUseFilesResult,
}))

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('FileExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkspaceStore.activeWorkspaceId = 'ws-1'
    mockUseFilesResult = {
      results: [],
      loading: false,
      error: undefined,
      truncated: false,
      search: vi.fn(),
      clear: vi.fn(),
    }
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [] }),
      }),
    ) as unknown as typeof global.fetch
  })

  afterEach(() => {
    cleanup()
  })

  it('renders an empty state when no workspace is active', () => {
    mockWorkspaceStore.activeWorkspaceId = null
    renderWithI18n(<FileExplorer onFileClick={vi.fn()} />)
    expect(screen.getByText('Open a workspace to browse files')).toBeInTheDocument()
  })

  it('renders the root file tree and expands folders on click', async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.includes('?path=src')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ nodes: [{ name: 'App.tsx', type: 'file' }] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              { name: 'src', type: 'folder' },
              { name: 'README.md', type: 'file' },
            ],
          }),
      })
    }) as unknown as typeof global.fetch

    renderWithI18n(<FileExplorer onFileClick={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })
    expect(screen.getByText('src')).toBeInTheDocument()

    fireEvent.click(screen.getByText('src'))

    await waitFor(() => {
      expect(screen.getByText('App.tsx')).toBeInTheDocument()
    })
  })

  it('selects a file on single click and highlights it', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [{ name: 'README.md', type: 'file' }] }),
      }),
    ) as unknown as typeof global.fetch

    const onSelectPath = vi.fn()
    const { rerender } = renderWithI18n(
      <FileExplorer selectedPath="" onSelectPath={onSelectPath} onFileClick={vi.fn()} />,
    )

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('README.md'))
    expect(onSelectPath).toHaveBeenCalledWith('README.md')

    rerender(
      <I18nextProvider i18n={i18n}>
        <FileExplorer selectedPath="README.md" onSelectPath={onSelectPath} onFileClick={vi.fn()} />
      </I18nextProvider>,
    )

    expect(screen.getByText('README.md').parentElement).toHaveClass('bg-accent/10')
    expect(screen.getByText('README.md').parentElement).toHaveClass('text-text-primary')
  })

  it('opens a file on double click', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [{ name: 'README.md', type: 'file' }] }),
      }),
    ) as unknown as typeof global.fetch

    const onFileClick = vi.fn()
    renderWithI18n(<FileExplorer onFileClick={onFileClick} />)

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })

    fireEvent.doubleClick(screen.getByText('README.md'))
    expect(onFileClick).toHaveBeenCalledWith('README.md', 'README.md')
  })

  it('shows the context menu on right click', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [{ name: 'README.md', type: 'file' }] }),
      }),
    ) as unknown as typeof global.fetch

    renderWithI18n(<FileExplorer onFileClick={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })

    fireEvent.contextMenu(screen.getByText('README.md'))

    expect(screen.getByText('Reveal in Finder')).toBeInTheDocument()
    expect(screen.getByText('Copy full path')).toBeInTheDocument()
  })

  it('supports single-click select and double-click open for search results', async () => {
    mockUseFilesResult = {
      results: [{ path: 'src/utils.ts' }],
      loading: false,
      error: undefined,
      truncated: false,
      search: vi.fn(),
      clear: vi.fn(),
    }

    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [] }),
      }),
    ) as unknown as typeof global.fetch

    const onSelectPath = vi.fn()
    const onFileClick = vi.fn()
    const { rerender } = renderWithI18n(
      <FileExplorer
        selectedPath=""
        onSelectPath={onSelectPath}
        onFileClick={onFileClick}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Search files…'), {
      target: { value: 'util' },
    })

    await waitFor(() => {
      expect(screen.getByText('src/utils.ts')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('src/utils.ts'))
    expect(onSelectPath).toHaveBeenCalledWith('src/utils.ts')

    rerender(
      <I18nextProvider i18n={i18n}>
        <FileExplorer
          selectedPath="src/utils.ts"
          onSelectPath={onSelectPath}
          onFileClick={onFileClick}
        />
      </I18nextProvider>,
    )

    expect(screen.getByText('src/utils.ts').parentElement).toHaveClass('bg-accent/10')

    fireEvent.doubleClick(screen.getByText('src/utils.ts'))
    expect(onFileClick).toHaveBeenCalledWith('src/utils.ts', 'utils.ts')
  })
})
