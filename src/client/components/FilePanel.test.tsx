import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import FilePanel from './FilePanel'
import i18n from '../i18n'

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('FilePanel', () => {
  it('renders relative path in header with absolute tooltip', () => {
    renderWithI18n(
      <FilePanel
        files={[{ path: 'src/components/Button.tsx', name: 'Button.tsx', content: 'const x = 1' }]}
        activeFilePath="src/components/Button.tsx"
        width={384}
        workspacePath="/workspace"
        onSelectFile={vi.fn()}
        onCloseFile={vi.fn()}
        onWidthChange={vi.fn()}
        onCopy={vi.fn()}
      />,
    )

    const pathEl = screen.getByText('src/components/Button.tsx')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')
  })

  it('renders relative path in header when workspacePath is absent', () => {
    renderWithI18n(
      <FilePanel
        files={[{ path: 'src/components/Button.tsx', name: 'Button.tsx', content: 'const x = 1' }]}
        activeFilePath="src/components/Button.tsx"
        width={384}
        onSelectFile={vi.fn()}
        onCloseFile={vi.fn()}
        onWidthChange={vi.fn()}
        onCopy={vi.fn()}
      />,
    )

    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()
  })

  it('renders nothing when no files are open', () => {
    const { container } = renderWithI18n(
      <FilePanel
        files={[]}
        activeFilePath=""
        width={384}
        onSelectFile={vi.fn()}
        onCloseFile={vi.fn()}
        onWidthChange={vi.fn()}
        onCopy={vi.fn()}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
