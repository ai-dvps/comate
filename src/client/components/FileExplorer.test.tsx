import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import FileExplorer from './FileExplorer'
import type { UseFilesResult } from '../stores/files-store'

import { revealInFileManager } from '../lib/desktop-api'

vi.mock('../lib/desktop-api')

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

  it('refreshes the root tree and any expanded folders on demand', async () => {
    let rootLoadCount = 0
    let folderLoadCount = 0
    global.fetch = vi.fn((url: string) => {
      if (url.includes('?path=src')) {
        folderLoadCount += 1
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            nodes: folderLoadCount === 1
              ? [{ name: 'App.tsx', type: 'file' }]
              : [
                  { name: 'App.tsx', type: 'file' },
                  { name: 'new-helper.ts', type: 'file' },
                ],
          }),
        })
      }

      rootLoadCount += 1
      const nodes = rootLoadCount === 1
        ? [{ name: 'src', type: 'folder' }]
        : [
            { name: 'src', type: 'folder' },
            { name: 'CHANGELOG.md', type: 'file' },
          ]
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes }),
      })
    }) as unknown as typeof global.fetch

    renderWithI18n(<FileExplorer onFileClick={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument())
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.getByText('App.tsx')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))

    await waitFor(() => {
      expect(screen.getByText('CHANGELOG.md')).toBeInTheDocument()
      expect(screen.getByText('new-helper.ts')).toBeInTheDocument()
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

  it('previews a file on single click', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [{ name: 'README.md', type: 'file' }] }),
      }),
    ) as unknown as typeof global.fetch

    const onFilePreview = vi.fn()
    renderWithI18n(
      <FileExplorer onFilePreview={onFilePreview} onFileClick={vi.fn()} />,
    )
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    fireEvent.click(screen.getByText('README.md'))
    expect(onFilePreview).toHaveBeenCalledWith('README.md', 'README.md')
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

  it('reveals a file via the desktop bridge from the context menu', async () => {
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
    fireEvent.click(screen.getByText('Reveal in Finder'))

    await waitFor(() => {
      expect(revealInFileManager).toHaveBeenCalledWith('/project/README.md')
    })
  })

  it('supports single-click select and double-click open for search results', async () => {
    mockUseFilesResult = {
      results: [{ path: 'src/utils.ts', type: 'file' }],
      loading: false,
      error: undefined,
      truncated: false,
      search: vi.fn(),
      clear: vi.fn(),
    }

    global.fetch = vi.fn((url: string) => {
      if (url.includes('?path=src')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ nodes: [{ name: 'utils.ts', type: 'file' }] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [{ name: 'src', type: 'folder' }] }),
      })
    }) as unknown as typeof global.fetch

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

    await waitFor(() => {
      expect(mockUseFilesResult.clear).toHaveBeenCalled()
      expect(screen.getByPlaceholderText('Search files…')).toHaveValue('')
      expect(screen.getByText('utils.ts')).toBeInTheDocument()
    })

    expect(screen.getByText('utils.ts').parentElement).toHaveClass('bg-accent/10')

    fireEvent.doubleClick(screen.getByText('utils.ts'))
    expect(onFileClick).toHaveBeenCalledWith('src/utils.ts', 'utils.ts')
  })

  it('exits search and reveals nested files when selectedPath changes', async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.includes('?path=src')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ nodes: [{ name: 'utils.ts', type: 'file' }] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ nodes: [{ name: 'src', type: 'folder' }] }),
      })
    }) as unknown as typeof global.fetch

    mockUseFilesResult = {
      results: [{ path: 'src/utils.ts', type: 'file' }],
      loading: false,
      error: undefined,
      truncated: false,
      search: vi.fn(),
      clear: vi.fn(),
    }

    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    const { rerender } = renderWithI18n(
      <FileExplorer selectedPath="README.md" onFileClick={vi.fn()} />,
    )

    fireEvent.change(screen.getByPlaceholderText('Search files…'), {
      target: { value: 'util' },
    })

    await waitFor(() => {
      expect(screen.getByText('src/utils.ts')).toBeInTheDocument()
    })

    rerender(
      <I18nextProvider i18n={i18n}>
        <FileExplorer selectedPath="src/utils.ts" onFileClick={vi.fn()} />
      </I18nextProvider>,
    )

    await waitFor(() => {
      expect(mockUseFilesResult.clear).toHaveBeenCalled()
      expect(screen.getByPlaceholderText('Search files…')).toHaveValue('')
      expect(screen.getByText('utils.ts')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ block: 'nearest', behavior: 'smooth' }),
      )
    })

    expect(screen.getByTestId('file-tree-item')).toHaveAttribute('data-path', 'src/utils.ts')
    expect(screen.getByText('utils.ts').parentElement).toHaveClass('bg-accent/10')
  })
})
