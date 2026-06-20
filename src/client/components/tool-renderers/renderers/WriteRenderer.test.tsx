import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import './WriteRenderer'
import { getToolRenderer } from '../registry'
import { ToolRendererProvider } from '../ToolRendererContext'

const renderer = getToolRenderer('Write')!

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

describe('WriteRenderer', () => {
  it('shows relative path for file_path and opens file on click', async () => {
    const onOpenFile = vi.fn()
    renderWithProvider(
      renderer({ file_path: '/workspace/src/components/Button.tsx', content: 'export function Button() {}' }),
      { onOpenFile },
    )

    const pathEl = screen.getByText('src/components/Button.tsx')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')

    fireEvent.click(pathEl, { metaKey: true })
    expect(onOpenFile).toHaveBeenCalledWith('src/components/Button.tsx', 'Button.tsx')
  })

  it('renders nothing when file_path or content is missing', () => {
    const { container } = renderWithProvider(renderer({ file_path: '/workspace/foo.txt' }))
    expect(container).toBeEmptyDOMElement()
  })
})
