import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import './EditRenderer'
import { getToolRenderer } from '../registry'
import { ToolRendererProvider } from '../ToolRendererContext'

const { unifiedMergeViewMock } = vi.hoisted(() => ({
  unifiedMergeViewMock: vi.fn(() => []),
}))

vi.mock('@codemirror/merge', () => ({
  unifiedMergeView: unifiedMergeViewMock,
}))

vi.mock('../../CodeMirrorEditor', () => ({
  default: ({
    value,
    language,
    readOnly,
    extensions,
  }: {
    value?: string
    language: unknown
    readOnly: boolean
    extensions?: unknown[]
  }) => (
    <div
      data-testid="edit-diff"
      data-value={value}
      data-language={language === null ? 'plain' : 'syntax'}
      data-read-only={String(readOnly)}
      data-extension-count={extensions?.length ?? 0}
    />
  ),
}))

const renderer = getToolRenderer('Edit')!

function renderWithProvider(
  node: ReactNode,
  { workspacePath = '/workspace', onOpenFile = vi.fn() }: { workspacePath?: string; onOpenFile?: (path: string, name: string) => void } = {},
) {
  return render(
    <ToolRendererProvider value={{ workspacePath, onOpenFile }}>
      {node}
    </ToolRendererProvider>,
  )
}

describe('EditRenderer', () => {
  it('renders old and new strings as one read-only unified diff', () => {
    renderWithProvider(
      renderer({
        file_path: '/workspace/src/components/Button.tsx',
        old_string: 'const tone = "neutral"',
        new_string: 'const tone = danger ? "danger" : "neutral"',
      }),
    )

    const diff = screen.getByTestId('edit-diff')
    expect(diff).toHaveAttribute('data-value', 'const tone = danger ? "danger" : "neutral"')
    expect(diff).toHaveAttribute('data-language', 'syntax')
    expect(diff).toHaveAttribute('data-read-only', 'true')
    expect(diff).toHaveAttribute('data-extension-count', '1')
    expect(screen.queryByText('Before')).not.toBeInTheDocument()
    expect(screen.queryByText('After')).not.toBeInTheDocument()
    expect(unifiedMergeViewMock).toHaveBeenCalledWith({
      original: 'const tone = "neutral"',
      highlightChanges: true,
      gutter: true,
      syntaxHighlightDeletions: true,
      mergeControls: false,
    })
  })

  it('renders an addition-only diff when old_string is empty', () => {
    renderWithProvider(
      renderer({
        file_path: '/workspace/src/new.ts',
        old_string: '',
        new_string: 'export const added = true',
      }),
    )

    expect(screen.getByTestId('edit-diff')).toHaveAttribute(
      'data-value',
      'export const added = true',
    )
    expect(unifiedMergeViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: '' }),
    )
  })

  it('renders a deletion-only diff when new_string is empty', () => {
    renderWithProvider(
      renderer({
        file_path: '/workspace/src/removed.ts',
        old_string: 'export const removed = true',
        new_string: '',
      }),
    )

    expect(screen.getByTestId('edit-diff')).toHaveAttribute('data-value', '')
    expect(unifiedMergeViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'export const removed = true' }),
    )
  })

  it('omits the diff when both strings are empty', () => {
    renderWithProvider(
      renderer({
        file_path: '/workspace/src/unchanged.ts',
        old_string: '',
        new_string: '',
      }),
    )

    expect(screen.getByText('Editing')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-diff')).not.toBeInTheDocument()
  })

  it('returns no content for malformed input', () => {
    const { container } = renderWithProvider(
      renderer({
        file_path: '/workspace/src/invalid.ts',
        old_string: 'old',
      }),
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('shows relative path for file_path and opens file on click', async () => {
    const onOpenFile = vi.fn()
    renderWithProvider(
      renderer({
        file_path: '/workspace/src/components/Button.tsx',
        old_string: 'old',
        new_string: 'new',
      }),
      { onOpenFile },
    )

    const pathEl = screen.getByText('src/components/Button.tsx')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')

    fireEvent.click(pathEl, { metaKey: true })
    expect(onOpenFile).toHaveBeenCalledWith('src/components/Button.tsx', 'Button.tsx')
  })

  it('shows replace all badge when replace_all is true', () => {
    renderWithProvider(
      renderer({
        file_path: '/workspace/src/components/Button.tsx',
        old_string: 'old',
        new_string: 'new',
        replace_all: true,
      }),
    )

    expect(screen.getByText('Replace all')).toBeInTheDocument()
  })
})
