import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { ToolHeader } from './tool'
import i18n from '../../i18n'
import { ToolRendererProvider } from '../tool-renderers/ToolRendererContext'

function renderWithProviders(
  ui: ReactElement,
  {
    workspacePath = '/workspace',
    onOpenFile = vi.fn(),
  }: { workspacePath?: string; onOpenFile?: (path: string, name: string) => void } = {},
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ToolRendererProvider value={{ workspacePath, onOpenFile }}>
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

  it('opens file when path summary is clicked', async () => {
    const onOpenFile = vi.fn()
    renderWithProviders(
      <ToolHeader
        type="tool-Read"
        state="output-available"
        summary="/workspace/src/components/Button.tsx"
      />,
      { onOpenFile },
    )

    await userEvent.click(screen.getByText('src/components/Button.tsx'))
    expect(onOpenFile).toHaveBeenCalledWith('src/components/Button.tsx', 'Button.tsx')
  })

  it('renders path summary as-is and non-clickable when outside workspace', async () => {
    const onOpenFile = vi.fn()
    renderWithProviders(
      <ToolHeader
        type="tool-Read"
        state="output-available"
        summary="/etc/passwd"
      />,
      { onOpenFile },
    )

    const summaryEl = screen.getByText('/etc/passwd')
    expect(summaryEl.tagName.toLowerCase()).toBe('span')
    await userEvent.click(summaryEl)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('renders directory tool path summary non-clickable', async () => {
    const onOpenFile = vi.fn()
    renderWithProviders(
      <ToolHeader
        type="tool-Glob"
        state="output-available"
        summary="/workspace/src/components"
      />,
      { onOpenFile },
    )

    const summaryEl = screen.getByText('src/components')
    expect(summaryEl.tagName.toLowerCase()).toBe('span')
    await userEvent.click(summaryEl)
    expect(onOpenFile).not.toHaveBeenCalled()
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

  it('renders URL summary unchanged', () => {
    renderWithProviders(
      <ToolHeader
        type="tool-WebFetch"
        state="output-available"
        summary="https://example.com/path"
      />,
    )

    expect(screen.getByText('https://example.com/path')).toBeInTheDocument()
  })
})
