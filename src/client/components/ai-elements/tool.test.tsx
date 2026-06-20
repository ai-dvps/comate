import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { ToolHeader } from './tool'
import i18n from '../../i18n'
import { ToolRendererProvider } from '../tool-renderers/ToolRendererContext'

function renderWithProviders(
  ui: ReactElement,
  { workspacePath = '/workspace' }: { workspacePath?: string } = {},
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ToolRendererProvider value={{ workspacePath, onOpenFile: vi.fn() }}>
        {ui}
      </ToolRendererProvider>
    </I18nextProvider>,
  )
}

describe('ToolHeader', () => {
  it('renders path summary as relative path with absolute tooltip', () => {
    renderWithProviders(
      <ToolHeader
        type="tool-Read"
        state="output-available"
        summary="/workspace/src/components/Button.tsx"
      />,
    )

    const summaryEl = screen.getByText('src/components/Button.tsx')
    expect(summaryEl).toBeInTheDocument()
    expect(summaryEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')
  })

  it('renders path summary as-is when outside workspace', () => {
    renderWithProviders(
      <ToolHeader
        type="tool-Read"
        state="output-available"
        summary="/etc/passwd"
      />,
    )

    const summaryEl = screen.getByText('/etc/passwd')
    expect(summaryEl).toBeInTheDocument()
    expect(summaryEl).toHaveAttribute('title', '/etc/passwd')
  })

  it('renders non-path summary unchanged', () => {
    renderWithProviders(
      <ToolHeader
        type="tool-Bash"
        state="output-available"
        summary="npm run build"
      />,
    )

    expect(screen.getByText('npm run build')).toBeInTheDocument()
  })
})
