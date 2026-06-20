import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import './GrepRenderer'
import { getToolRenderer } from '../registry'
import { ToolRendererProvider } from '../ToolRendererContext'

const renderer = getToolRenderer('Grep')!

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

describe('GrepRenderer', () => {
  it('shows relative path for path and keeps it non-clickable', () => {
    const onOpenFile = vi.fn()
    renderWithProvider(
      renderer({ pattern: 'className', path: '/workspace/src/components', output_mode: 'per_line' }),
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
      renderer({ pattern: 'className', path: '/workspace/src/components' }),
      { onOpenFile },
    )

    await userEvent.click(screen.getByText('src/components'))
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('shows output mode badge when provided', () => {
    renderWithProvider(
      renderer({ pattern: 'className', path: '/workspace/src/components', output_mode: 'per_line' }),
    )

    expect(screen.getByText('per_line')).toBeInTheDocument()
  })
})
