import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import GitDiffPanel, { ViewedDiff } from './GitDiffPanel'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

vi.mock('@git-diff-view/react', () => ({
  DiffView: vi.fn(({ data, diffViewMode, diffViewTheme, diffViewFontSize }: {
    data?: { hunks?: string[] }
    diffViewMode?: number
    diffViewTheme?: string
    diffViewFontSize?: number
  }) => (
    <div
      data-testid="git-diff-view"
      data-mode={diffViewMode}
      data-theme={diffViewTheme}
      data-font-size={diffViewFontSize}
    >
      <pre data-testid="git-diff-hunks">{data?.hunks?.[0] ?? ''}</pre>
    </div>
  )),
  DiffModeEnum: {
    SplitGitHub: 1,
    SplitGitLab: 2,
    Split: 3,
    Unified: 4,
  },
}))

const DEFAULT_PROPS = {
  files: [] as ViewedDiff[],
  activeFilePath: '',
  width: 400,
  workspacePath: '/workspace',
  uiFontSize: 'medium' as const,
  onSelectFile: vi.fn(),
  onCloseFile: vi.fn(),
  onWidthChange: vi.fn(),
}

describe('GitDiffPanel', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders nothing when no diffs are open', () => {
    const { container } = renderWithI18n(<GitDiffPanel {...DEFAULT_PROPS} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a diff tab and content', () => {
    const props = {
      ...DEFAULT_PROPS,
      files: [
        {
          path: 'src/main.ts',
          name: 'main.ts',
          diff: '-old\n+new',
          isBinary: false,
          truncated: false,
          isUntracked: false,
          isDeleted: false,
        },
      ],
      activeFilePath: 'src/main.ts',
    }

    renderWithI18n(<GitDiffPanel {...props} />)

    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('src/main.ts')).toBeInTheDocument()
    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument()
    expect(screen.getByTestId('git-diff-hunks').textContent).toBe('-old\n+new')
  })

  it('renders untracked file content', () => {
    const props = {
      ...DEFAULT_PROPS,
      files: [
        {
          path: 'new.txt',
          name: 'new.txt',
          diff: '',
          isBinary: false,
          truncated: false,
          isUntracked: true,
          isDeleted: false,
          untrackedContent: 'hello world',
        },
      ],
      activeFilePath: 'new.txt',
    }

    renderWithI18n(<GitDiffPanel {...props} />)

    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('calls onSelectFile when a tab is clicked', () => {
    const props = {
      ...DEFAULT_PROPS,
      files: [
        {
          path: 'a.ts',
          name: 'a.ts',
          diff: '-a\n+a2',
          isBinary: false,
          truncated: false,
          isUntracked: false,
          isDeleted: false,
        },
        {
          path: 'b.ts',
          name: 'b.ts',
          diff: '-b\n+b2',
          isBinary: false,
          truncated: false,
          isUntracked: false,
          isDeleted: false,
        },
      ],
      activeFilePath: 'a.ts',
    }

    renderWithI18n(<GitDiffPanel {...props} />)

    fireEvent.click(screen.getByText('b.ts'))
    expect(props.onSelectFile).toHaveBeenCalledWith('b.ts')
  })

  it('renders deleted file header for deleted files', () => {
    const props = {
      ...DEFAULT_PROPS,
      files: [
        {
          path: 'deleted.ts',
          name: 'deleted.ts',
          diff: '-removed line',
          isBinary: false,
          truncated: false,
          isUntracked: false,
          isDeleted: true,
        },
      ],
      activeFilePath: 'deleted.ts',
    }

    renderWithI18n(<GitDiffPanel {...props} />)

    expect(screen.getByText('File deleted')).toBeInTheDocument()
    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument()
  })

  it('calls onCloseFile when tab close button is clicked', () => {
    const props = {
      ...DEFAULT_PROPS,
      files: [
        {
          path: 'src/main.ts',
          name: 'main.ts',
          diff: '-old\n+new',
          isBinary: false,
          truncated: false,
          isUntracked: false,
          isDeleted: false,
        },
      ],
      activeFilePath: 'src/main.ts',
    }

    renderWithI18n(<GitDiffPanel {...props} />)

    const closeButton = screen.getByTitle('Close')
    fireEvent.click(closeButton)
    expect(props.onCloseFile).toHaveBeenCalledWith('src/main.ts')
  })

  it('renders error state', () => {
    const props = {
      ...DEFAULT_PROPS,
      files: [
        {
          path: 'error.ts',
          name: 'error.ts',
          diff: '',
          isBinary: false,
          truncated: false,
          isUntracked: false,
          isDeleted: false,
          error: 'Network error',
        },
      ],
      activeFilePath: 'error.ts',
    }

    renderWithI18n(<GitDiffPanel {...props} />)

    expect(screen.getByText('Network error')).toBeInTheDocument()
  })

  it('passes the configured UI font size to the diff view', () => {
    const props = {
      ...DEFAULT_PROPS,
      uiFontSize: 'large' as const,
      files: [
        {
          path: 'src/main.ts',
          name: 'main.ts',
          diff: '-old\n+new',
          isBinary: false,
          truncated: false,
          isUntracked: false,
          isDeleted: false,
        },
      ],
      activeFilePath: 'src/main.ts',
    }

    renderWithI18n(<GitDiffPanel {...props} />)

    expect(screen.getByTestId('git-diff-view')).toHaveAttribute('data-font-size', '16')
  })
})
