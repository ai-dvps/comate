import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { ToolHeader, ToolContent, ToolOutput } from './tool'
import i18n from '../../i18n'
import { ToolRendererProvider } from '../tool-renderers/ToolRendererContext'

const openUrlMock = vi.fn()

vi.mock('../../lib/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/open-url')>()
  return {
    ...actual,
    openUrlInBrowser: (...args: unknown[]) => openUrlMock(...args),
  }
})

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
  const originalClipboard = navigator.clipboard

  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    Object.assign(navigator, { clipboard: originalClipboard })
  })

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

    fireEvent.click(screen.getByText('src/components/Button.tsx'), { metaKey: true })
    expect(onOpenFile).toHaveBeenCalledWith('src/components/Button.tsx', 'Button.tsx')
  })

  it('copies relative path when copy button in path summary is clicked', async () => {
    renderWithProviders(
      <ToolHeader
        type="tool-Read"
        state="output-available"
        summary="/workspace/src/components/Button.tsx"
      />,
    )

    const copyButton = screen.getByRole('button', { name: 'Copy path' })
    await userEvent.click(copyButton)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('src/components/Button.tsx')
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

describe('ToolContent', () => {
  it('renders children fully without a toggle', () => {
    renderWithProviders(
      <ToolContent>
        <div>tool body content</div>
      </ToolContent>,
    )

    expect(screen.getByText('tool body content')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Show details')).not.toBeInTheDocument()
    expect(screen.queryByText('Hide details')).not.toBeInTheDocument()
  })

  it('collapses overflowing content and expands on toggle click', async () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight',
    )
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    })

    renderWithProviders(
      <ToolContent alwaysExpanded={false}>
        <div style={{ height: '300px' }}> tall tool body </div>
      </ToolContent>,
    )

    expect(screen.getByText('tall tool body')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /Show details/i })
    expect(toggle).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(screen.getByRole('button', { name: /Hide details/i })).toBeInTheDocument()

    if (originalScrollHeight) {
      Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight)
    } else {
      delete (Element.prototype as { scrollHeight?: number }).scrollHeight
    }
  })

  it('keeps content expanded when forceExpanded is true', () => {
    renderWithProviders(
      <ToolContent alwaysExpanded={false} forceExpanded>
        <div style={{ height: '300px' }}> forced tool body </div>
      </ToolContent>,
    )

    expect(screen.getByText('forced tool body')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show details/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Hide details/i })).not.toBeInTheDocument()
  })

  it('applies search-match ring classes when matched', () => {
    const { container } = renderWithProviders(
      <ToolContent hasSearchMatch isCurrentSearchMatch>
        <div>matched tool body</div>
      </ToolContent>,
    )

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('ring-1')
    expect(wrapper).toHaveClass('ring-accent')
    expect(wrapper).toHaveClass('bg-accent/5')
  })
})

describe('ToolOutput', () => {
  beforeEach(() => {
    openUrlMock.mockClear()
  })

  it('renders error text with modifier-clickable URLs', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ToolOutput errorText="Failed to fetch https://example.com/data" output={undefined} />,
    )

    const urlSpan = screen.getByText('https://example.com/data')
    await user.keyboard('{Meta>}')
    await user.click(urlSpan)
    await user.keyboard('{/Meta}')

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/data')
  })

  it('does not open URLs in error text on plain click', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ToolOutput errorText="Failed to fetch https://example.com/data" output={undefined} />,
    )

    await user.click(screen.getByText('https://example.com/data'))
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('keeps string output in CodeBlock without linkification', () => {
    renderWithProviders(
      <ToolOutput output="result: https://example.com/data" errorText={undefined} />,
    )

    expect(document.querySelector('[data-language="json"]')).toBeInTheDocument()
    const urlSpan = screen.getByText(/https:\/\/example\.com\/data/)
    expect(urlSpan.closest('a')).toBeNull()
  })
})
