import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { Tool, ToolHeader, ToolContent, ToolOutput } from './tool'
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const renderCard = (
    body: ReactElement = <div>tool body content</div>,
    cardProps: { hasSearchMatch?: boolean; isCurrentSearchMatch?: boolean } = {},
    contentProps: { forceExpanded?: boolean } = {},
  ) => (
    <I18nextProvider i18n={i18n}>
      <ToolRendererProvider value={{ workspacePath: '/workspace', onOpenFile: vi.fn() }}>
        <Tool
          hasSearchMatch={cardProps.hasSearchMatch}
          isCurrentSearchMatch={cardProps.isCurrentSearchMatch}
        >
          <ToolHeader type="tool-Bash" state="output-available" />
          <ToolContent forceExpanded={contentProps.forceExpanded}>
            {body}
          </ToolContent>
        </Tool>
      </ToolRendererProvider>
    </I18nextProvider>
  )

  it('renders collapsed by default: header visible, body hidden, no show more/less', () => {
    render(renderCard())

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.queryByText('tool body content')).not.toBeInTheDocument()
    expect(screen.queryByText('Show details')).not.toBeInTheDocument()
    expect(screen.queryByText('Hide details')).not.toBeInTheDocument()
    expect(screen.queryByText('Show more')).not.toBeInTheDocument()
    expect(screen.queryByText('Show less')).not.toBeInTheDocument()
  })

  it('expands and collapses via the header-end icon button', async () => {
    render(renderCard())

    const toggle = screen.getByRole('button', { name: 'Expand tool details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(screen.getByText('tool body content')).toBeInTheDocument()
    const collapseToggle = screen.getByRole('button', { name: 'Collapse tool details' })
    expect(collapseToggle).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(collapseToggle)
    expect(screen.queryByText('tool body content')).not.toBeInTheDocument()
  })

  it('caps the expanded body with a single 40vh scroll container', async () => {
    render(renderCard())

    await userEvent.click(screen.getByRole('button', { name: 'Expand tool details' }))

    const body = screen.getByText('tool body content').closest('[data-tool-content]')
    expect(body).toHaveClass('max-h-[40vh]')
    expect(body).toHaveClass('overflow-y-auto')
  })

  it('force-expands for a current search hit, scrolls the hit into view, and never force-collapses', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { rerender } = render(
      renderCard(<div>hit tool body</div>, { hasSearchMatch: true, isCurrentSearchMatch: true }, { forceExpanded: true }),
    )

    expect(screen.getByText('hit tool body')).toBeInTheDocument()
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })

    // One-way semantics: clearing the flag must not collapse the card.
    rerender(
      renderCard(<div>hit tool body</div>, { hasSearchMatch: true, isCurrentSearchMatch: true }, { forceExpanded: false }),
    )
    expect(screen.getByText('hit tool body')).toBeInTheDocument()
  })

  it('shows the accent ring on the card root while collapsed for the current match', () => {
    const { container } = render(
      renderCard(<div>matched body</div>, { hasSearchMatch: true, isCurrentSearchMatch: true }),
    )

    const root = container.firstChild as HTMLElement
    expect(root).toHaveClass('ring-1')
    expect(root).toHaveClass('bg-accent/5')
    expect(root).toHaveClass('ring-accent')
    expect(screen.queryByText('matched body')).not.toBeInTheDocument()
  })

  it('shows a muted ring on the card root for a non-current match without expanding', () => {
    const { container } = render(
      renderCard(<div>matched body</div>, { hasSearchMatch: true }),
    )

    const root = container.firstChild as HTMLElement
    expect(root).toHaveClass('ring-1')
    expect(root).toHaveClass('bg-accent/5')
    expect(root).toHaveClass('ring-accent/30')
    expect(root).not.toHaveClass('ring-accent')
    expect(screen.queryByText('matched body')).not.toBeInTheDocument()
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
