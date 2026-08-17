import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import MarkdownPreview from './MarkdownPreview'

const streamdownMock = vi.hoisted(() => ({ shouldThrow: false }))
const preventExpectedWindowError = (event: ErrorEvent) => event.preventDefault()

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: React.ReactNode }) => {
    if (streamdownMock.shouldThrow) {
      throw new Error('Failed to fetch dynamically imported Mermaid module')
    }
    return <div>{children}</div>
  },
}))

describe('MarkdownPreview', () => {
  beforeEach(() => {
    streamdownMock.shouldThrow = false
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.addEventListener('error', preventExpectedWindowError)
  })

  afterEach(() => {
    window.removeEventListener('error', preventExpectedWindowError)
    vi.restoreAllMocks()
  })

  it('contains renderer failures instead of unmounting the surrounding UI', () => {
    streamdownMock.shouldThrow = true

    render(
      <I18nextProvider i18n={i18n}>
        <div>
          <span>Workspace remains available</span>
          <MarkdownPreview content={'```mermaid\ngraph TD\n```'} />
        </div>
      </I18nextProvider>,
    )

    expect(screen.getByText('Workspace remains available')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to render this Markdown preview')
  })

  it('retries rendering when the Markdown content changes', () => {
    streamdownMock.shouldThrow = true

    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <MarkdownPreview content={'```mermaid\ngraph TD\n```'} />
      </I18nextProvider>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    streamdownMock.shouldThrow = false
    rerender(
      <I18nextProvider i18n={i18n}>
        <MarkdownPreview content="Recovered preview" />
      </I18nextProvider>,
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Recovered preview')).toBeInTheDocument()
  })
})
