import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import './EditRenderer'
import { getToolRenderer } from '../registry'
import { ToolRendererProvider } from '../ToolRendererContext'

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

    await userEvent.click(pathEl)
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
