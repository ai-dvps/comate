import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { Reasoning, ReasoningTrigger, ReasoningContent } from './reasoning'
import type { ReasoningProps } from './reasoning'
import i18n from '../../i18n'

const renderReasoning = (
  reasoningProps: Partial<Omit<ReasoningProps, 'ref' | 'children'>> = {},
  body = 'thinking body content',
) => (
  <I18nextProvider i18n={i18n}>
    <Reasoning {...reasoningProps}>
      <ReasoningTrigger />
      <ReasoningContent>{body}</ReasoningContent>
    </Reasoning>
  </I18nextProvider>
)

describe('ReasoningTrigger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is collapsed by default and toggles only via the row-end icon button', async () => {
    render(renderReasoning())

    // Collapsed: body hidden, trigger row visible with static thinking text.
    expect(screen.getByText('Thought for a few seconds')).toBeInTheDocument()
    expect(screen.queryByText('thinking body content')).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: 'Expand thoughts' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.querySelector('svg')).toHaveClass('rotate-0')

    // Clicking the static row content (thinking text) must NOT toggle.
    await userEvent.click(screen.getByText('Thought for a few seconds'))
    expect(screen.queryByText('thinking body content')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand thoughts' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    // End icon expands.
    await userEvent.click(toggle)
    expect(screen.getByText('thinking body content')).toBeInTheDocument()
    const collapseToggle = screen.getByRole('button', { name: 'Collapse thoughts' })
    expect(collapseToggle).toHaveAttribute('aria-expanded', 'true')
    expect(collapseToggle.querySelector('svg')).toHaveClass('rotate-180')

    // Clicking the static row content while open must NOT collapse.
    await userEvent.click(screen.getByText('Thought for a few seconds'))
    expect(screen.getByText('thinking body content')).toBeInTheDocument()

    // End icon collapses again.
    await userEvent.click(collapseToggle)
    expect(screen.queryByText('thinking body content')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand thoughts' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })
})

describe('ReasoningContent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('caps the expanded body with a 40vh internal scroll container', async () => {
    render(renderReasoning())

    await userEvent.click(screen.getByRole('button', { name: 'Expand thoughts' }))

    const body = screen
      .getByText('thinking body content')
      .closest('[data-reasoning-content]')
    expect(body).toHaveClass('max-h-[40vh]')
    expect(body).toHaveClass('overflow-y-auto')
  })

  it('forceOpen expands one-way and scrolls the capped container into view', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const receivers: Element[] = []
    scrollSpy.mockImplementation(function (this: Element) {
      receivers.push(this)
    })

    const { container, rerender } = render(renderReasoning({ forceOpen: true }))

    expect(screen.getByText('thinking body content')).toBeInTheDocument()
    const content = container.querySelector('[data-reasoning-content]')
    expect(content).toHaveClass('max-h-[40vh]')
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    // No hit element inside: falls back to the container itself.
    expect(receivers).toContain(content)

    // One-way semantics: clearing forceOpen must not collapse the block.
    rerender(renderReasoning({ forceOpen: false }))
    expect(screen.getByText('thinking body content')).toBeInTheDocument()
  })

  it('forceOpen scrolls the active search hit into view when present', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const receivers: Element[] = []
    scrollSpy.mockImplementation(function (this: Element) {
      receivers.push(this)
    })

    const { container, rerender } = render(
      renderReasoning({ open: true, onOpenChange: () => {} }),
    )
    const content = container.querySelector('[data-reasoning-content]')
    expect(content).not.toBeNull()
    // Simulate the <mark data-search-active="true"> emitted by HighlightText.
    const hit = document.createElement('mark')
    hit.setAttribute('data-search-active', 'true')
    content!.appendChild(hit)

    rerender(
      renderReasoning({ open: true, forceOpen: true, onOpenChange: () => {} }),
    )

    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(receivers).toContain(hit)
  })
})

describe('Reasoning auto behavior', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('auto-opens while streaming and auto-closes after streaming ends by default', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      renderReasoning({ isStreaming: true }, 'streaming body content'),
    )

    // Auto-opened during streaming.
    expect(screen.getByText('streaming body content')).toBeInTheDocument()

    rerender(renderReasoning({ isStreaming: false }, 'streaming body content'))
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.queryByText('streaming body content')).not.toBeInTheDocument()
  })

  it('does not auto-close after streaming ends when disableAutoBehavior is set', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      renderReasoning(
        { isStreaming: true, disableAutoBehavior: true, defaultOpen: false },
        'disabled auto body',
      ),
    )

    // No auto-open while streaming.
    expect(screen.queryByText('disabled auto body')).not.toBeInTheDocument()

    // Manual expand via the end icon, then stop streaming: must stay open.
    fireEvent.click(screen.getByRole('button', { name: 'Expand thoughts' }))
    expect(screen.getByText('disabled auto body')).toBeInTheDocument()

    rerender(
      renderReasoning(
        { isStreaming: false, disableAutoBehavior: true, defaultOpen: false },
        'disabled auto body',
      ),
    )
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('disabled auto body')).toBeInTheDocument()
  })
})
