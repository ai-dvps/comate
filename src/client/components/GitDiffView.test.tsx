import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import GitDiffView from './GitDiffView'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const gitChangesMock = vi.hoisted(() => {
  const state = {
    selectedFile: null as { path: string; indexStatus: string; workingTreeStatus: string; staged: boolean } | null,
    diffContent: null as { diff: string; isBinary: boolean; truncated: boolean } | null,
    diffLoading: false,
    diffError: null as string | null,
  }
  function useGitChanges() {
    return state
  }
  return { state, useGitChanges }
})

vi.mock('../stores/git-changes-store', () => ({
  useGitChangesStore: { getState: () => ({}) },
  useGitChanges: gitChangesMock.useGitChanges,
}))

vi.mock('./ai-elements/code-block', () => ({
  CodeBlockContent: ({ code, className }: { code: string; className?: string }) => (
    <pre data-testid="code-block" data-class={className}>{code}</pre>
  ),
}))

vi.mock('./MarkdownPreview', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-preview">{content}</div>,
}))

const DEFAULT_PROPS = {
  workspaceId: 'ws1',
  panelWidth: 640,
  onBack: vi.fn(),
}

describe('GitDiffView', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    gitChangesMock.state.selectedFile = null
    gitChangesMock.state.diffContent = null
    gitChangesMock.state.diffLoading = false
    gitChangesMock.state.diffError = null
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: 'file content' }),
      }),
    ) as unknown as typeof global.fetch
  })

  it('renders full content for an untracked file', async () => {
    gitChangesMock.state.selectedFile = {
      path: 'readme.md',
      indexStatus: '?',
      workingTreeStatus: '?',
      staged: false,
    }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    await waitFor(() => expect(screen.getByText('file content')).toBeInTheDocument())
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws1/files/content?path=readme.md',
    )
  })

  it('renders a unified inline diff for a modified file', () => {
    gitChangesMock.state.selectedFile = {
      path: 'src/main.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
    }
    gitChangesMock.state.diffContent = { diff: '-old\n+new', isBinary: false, truncated: false }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    const blocks = screen.getAllByTestId('code-block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toHaveTextContent('-old')
  })

  it('toggles to side-by-side mode', () => {
    gitChangesMock.state.selectedFile = {
      path: 'src/main.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
    }
    gitChangesMock.state.diffContent = { diff: '-old\n+new', isBinary: false, truncated: false }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    fireEvent.click(screen.getByLabelText(/Side-by-side diff/i))

    expect(screen.getAllByTestId('code-block')).toHaveLength(2)
  })

  it('falls back to unified mode when the panel is too narrow', () => {
    gitChangesMock.state.selectedFile = {
      path: 'src/main.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
    }
    gitChangesMock.state.diffContent = { diff: '-old\n+new', isBinary: false, truncated: false }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} panelWidth={300} />)

    fireEvent.click(screen.getByLabelText(/Side-by-side diff/i))

    expect(screen.getAllByTestId('code-block')).toHaveLength(1)
  })

  it('shows a placeholder for binary diffs', () => {
    gitChangesMock.state.selectedFile = {
      path: 'image.png',
      indexStatus: 'M',
      workingTreeStatus: ' ',
      staged: true,
    }
    gitChangesMock.state.diffContent = { diff: 'Binary files differ', isBinary: true, truncated: false }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    expect(screen.getByText('Binary file changes cannot be shown')).toBeInTheDocument()
  })

  it('shows a placeholder for truncated diffs', () => {
    gitChangesMock.state.selectedFile = {
      path: 'src/main.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
    }
    gitChangesMock.state.diffContent = { diff: '-old\n+new', isBinary: false, truncated: true }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    expect(screen.getByText('Diff too large — showing first part')).toBeInTheDocument()
  })

  it('shows a deleted file header with only removed lines', () => {
    gitChangesMock.state.selectedFile = {
      path: 'src/main.ts',
      indexStatus: 'D',
      workingTreeStatus: ' ',
      staged: true,
    }
    gitChangesMock.state.diffContent = { diff: '-deleted line', isBinary: false, truncated: false }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    expect(screen.getByText('File deleted')).toBeInTheDocument()
    expect(screen.getByText('-deleted line')).toBeInTheDocument()
  })

  it('calls onBack when the back control is clicked', () => {
    gitChangesMock.state.selectedFile = {
      path: 'src/main.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
    }
    gitChangesMock.state.diffContent = { diff: '-old', isBinary: false, truncated: false }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    fireEvent.click(screen.getByLabelText(/Back to file list/i))
    expect(DEFAULT_PROPS.onBack).toHaveBeenCalledTimes(1)
  })

  it('calls onBack when Escape is pressed', () => {
    gitChangesMock.state.selectedFile = {
      path: 'src/main.ts',
      indexStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
    }
    gitChangesMock.state.diffContent = { diff: '-old', isBinary: false, truncated: false }

    renderWithI18n(<GitDiffView {...DEFAULT_PROPS} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(DEFAULT_PROPS.onBack).toHaveBeenCalledTimes(1)
  })
})
