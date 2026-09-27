import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import './GlobRenderer'
import { getToolRenderer } from '../registry'
import { ToolRendererProvider } from '../ToolRendererContext'

const renderer = getToolRenderer('Glob')!

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

describe('GlobRenderer', () => {
  it('shows relative path for path and keeps it non-clickable', () => {
    const onOpenFile = vi.fn()
    renderWithProvider(
      renderer({ pattern: '**/*.tsx', path: '/workspace/src/components' }),
      { onOpenFile },
    )

    const pathEl = screen.getByText('src/components')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components')
    expect(pathEl.tagName.toLowerCase()).toBe('span')
  })

  it('does not call onOpenFile when directory path is clicked', async () => {
    const onOpenFile = vi.fn()
    renderWithProvider(
      renderer({ pattern: '**/*.tsx', path: '/workspace/src/components' }),
      { onOpenFile },
    )

    await userEvent.click(screen.getByText('src/components'))
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('renders pattern without path when path is absent', () => {
    renderWithProvider(renderer({ pattern: '**/*.tsx' }))

    expect(screen.getByText('**/*.tsx')).toBeInTheDocument()
  })
})
