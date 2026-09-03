import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import '../index.css'

import ChatMessageRenderer, { type RenderableMessage } from './ChatMessageRenderer'
import i18n from '../i18n'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'
import { openUrlInBrowser } from '../lib/open-url'

vi.mock('../lib/open-url', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/open-url')>(),
  openUrlInBrowser: vi.fn(),
}))

afterEach(cleanup)

function renderUserPrompt(text: string, searchMatches: MessageSearchMatch[] = []) {
  const message: RenderableMessage = {
    id: 'user-markdown',
    role: 'user',
    parts: [{ type: 'text', text }],
  }
  const view = (matches: MessageSearchMatch[]) => (
    <I18nextProvider i18n={i18n}>
      <ChatMessageRenderer
        message={message}
        resultMap={new Map()}
        onOpenDrawer={() => {}}
        sessionId="session-1"
        searchMatches={matches}
        currentMatch={matches[0] ?? null}
      />
    </I18nextProvider>
  )
  const result = render(view(searchMatches))
  return {
    ...result,
    rerenderSearch: (matches: MessageSearchMatch[]) => result.rerender(view(matches)),
  }
}

describe('user prompt Markdown', () => {
  it('folds long rendered prompts, preserves chips, and reveals hidden search matches', async () => {
    const text = '- Run /review on @src/client/App.tsx\n' +
      Array.from({ length: 35 }, (_, index) => `- Item ${index}`).join('\n') +
      '\n- Unique tail'
    const { rerenderSearch } = renderUserPrompt(text)
    const toggle = await screen.findByRole('button', { name: i18n.t('chat:expandUserPrompt') })
    const viewport = document.getElementById(toggle.getAttribute('aria-controls')!)!

    expect(viewport.getBoundingClientRect().height).toBeLessThanOrEqual(300)
    expect(viewport.style.maskImage).toContain('linear-gradient')
    expect(document.querySelectorAll('[data-prompt-reference-chip]')).toHaveLength(2)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(viewport.getBoundingClientRect().height).toBeGreaterThan(300)
    expect(viewport.style.maskImage).toBe('')
    fireEvent.click(toggle)
    expect(viewport.getBoundingClientRect().height).toBeLessThanOrEqual(300)

    const start = text.indexOf('Unique tail')
    rerenderSearch([{ messageId: 'user-markdown', partIndex: 0, start, end: start + 11 }])
    await waitFor(() => {
      expect(viewport.getBoundingClientRect().height).toBeGreaterThan(300)
      const match = document.querySelector<HTMLElement>('[data-search-active="true"]')!
      expect(match).toHaveTextContent('Unique tail')
      expect(match.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom)
    })
    expect(screen.queryByRole('button', { name: i18n.t('chat:collapseUserPrompt') })).not.toBeInTheDocument()

    rerenderSearch([])
    expect(viewport.getBoundingClientRect().height).toBeLessThanOrEqual(300)
    expect(await screen.findByRole('button', { name: i18n.t('chat:expandUserPrompt') }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('adapts the fold control when resizing makes a prompt short again', async () => {
    const { container } = renderUserPrompt('Some prompt text. '.repeat(40))
    container.style.width = '160px'
    expect(await screen.findByRole('button', { name: i18n.t('chat:expandUserPrompt') })).toBeInTheDocument()

    container.style.width = '1100px'
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: i18n.t('chat:expandUserPrompt') })).not.toBeInTheDocument()
    })
  })

  it('renders Markdown and displays files and skills as composer-style chips', () => {
    renderUserPrompt('## Review\n\n- Run /review on @src/client/App.tsx')

    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument()
    const chips = document.querySelectorAll<HTMLElement>('[data-prompt-reference-chip]')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveTextContent('/review')
    expect(chips[1]).toHaveTextContent('@App.tsx')
    expect(chips[1]).toHaveAttribute('aria-label', '@src/client/App.tsx')
  })

  it('keeps Markdown rendered when a search match is active', () => {
    renderUserPrompt('## Review', [{ messageId: 'user-markdown', partIndex: 0, start: 3, end: 9 }])

    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument()
    expect(document.querySelector('[data-search-active="true"]')).toHaveTextContent('Review')
  })

  it('highlights an autolink without changing its Markdown link rendering', () => {
    renderUserPrompt('See https://example.com', [{ messageId: 'user-markdown', partIndex: 0, start: 4, end: 23 }])

    expect(screen.getByRole('link', { name: 'https://example.com' })).toBeInTheDocument()
    expect(document.querySelector('[data-search-active="true"]')).toHaveTextContent('https://example.com')
  })

  it('keeps a partially matched reference as an active chip', () => {
    renderUserPrompt('Use @src/client/App.tsx', [
      { messageId: 'user-markdown', partIndex: 0, start: 9, end: 12 },
    ])

    expect(document.querySelector('[data-prompt-reference-chip][data-search-active="true"]'))
      .toHaveTextContent('@App.tsx')
  })

  it('keeps unsafe Markdown URLs and HTML inert, and opens safe URLs only with a modifier', () => {
    renderUserPrompt('[unsafe](javascript:alert(1)) <img src="x" onerror="alert(1)"> https://example.com')

    expect(screen.queryByRole('link', { name: 'unsafe' })).not.toBeInTheDocument()
    expect(document.querySelector('img[onerror]')).not.toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'https://example.com' })
    expect(fireEvent.click(link)).toBe(false)
    expect(openUrlInBrowser).not.toHaveBeenCalled()

    fireEvent.click(link, { metaKey: true })
    expect(openUrlInBrowser).toHaveBeenCalledWith('https://example.com/')
  })

  it('re-renders user Markdown when search ranges change', () => {
    const { rerender } = renderUserPrompt('## Review')

    rerender(
      <I18nextProvider i18n={i18n}>
        <ChatMessageRenderer
          message={{ id: 'user-markdown', role: 'user', parts: [{ type: 'text', text: '## Review' }] }}
          resultMap={new Map()}
          onOpenDrawer={() => {}}
          sessionId="session-1"
          searchMatches={[{ messageId: 'user-markdown', partIndex: 0, start: 3, end: 9 }]}
          currentMatch={{ messageId: 'user-markdown', partIndex: 0, start: 3, end: 9 }}
        />
      </I18nextProvider>,
    )

    expect(document.querySelector('[data-search-active="true"]')).toHaveTextContent('Review')
  })
})
