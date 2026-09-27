import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import './ReadRenderer'
import { getToolRenderer } from '../registry'
import { ToolRendererProvider } from '../ToolRendererContext'

const renderer = getToolRenderer('Read')!

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

describe('ReadRenderer', () => {
  it('shows relative path and opens file on click', async () => {
    const onOpenFile = vi.fn()
    renderWithProvider(renderer({ file_path: '/workspace/src/components/Button.tsx' }), {
      onOpenFile,
    })

    const pathEl = screen.getByText('src/components/Button.tsx')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')

    fireEvent.click(pathEl, { metaKey: true })
    expect(onOpenFile).toHaveBeenCalledWith('src/components/Button.tsx', 'Button.tsx')
  })

  it('falls back to path when file_path is absent', () => {
    renderWithProvider(renderer({ path: '/workspace/README.md' }))

    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('renders nothing when no path is provided', () => {
    const { container } = renderWithProvider(renderer({}))
    expect(container).toBeEmptyDOMElement()
  })
})
