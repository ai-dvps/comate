import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import '../index.css'

import ChatMessageRenderer, { type RenderableMessage } from './ChatMessageRenderer'
import i18n from '../i18n'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const message: RenderableMessage = {
  id: 'process-region-message',
  role: 'assistant',
  parts: [
    {
      type: 'tool_use',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      isStreaming: false,
    },
  ],
}

const thinkingMessage: RenderableMessage = {
  id: 'process-region-thinking-message',
  role: 'assistant',
  parts: [{ type: 'thinking', text: 'Considering the next step', isStreaming: false }],
}

const imageMessage: RenderableMessage = {
  id: 'historical-images',
  role: 'user',
  parts: [
    { type: 'image', mediaType: 'image/png', name: 'one.png', source: { type: 'base64', data: 'iVBORw0KGgo=' } },
    { type: 'image', mediaType: 'image/webp', name: 'two.webp', source: { type: 'base64', data: 'UklGRg==' } },
  ],
}

describe('ChatMessageRenderer browser layout', () => {
  afterEach(cleanup)

  it('keeps historical thumbnails on one horizontally scrollable rail', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <div style={{ width: 160 }}>
          <ChatMessageRenderer
            message={imageMessage}
            resultMap={new Map()}
            onOpenDrawer={() => {}}
            sessionId="session-1"
          />
        </div>
      </I18nextProvider>,
    )

    const rail = screen.getByTestId('historical-image-rail')
    expect(getComputedStyle(rail).flexWrap).toBe('nowrap')
    expect(getComputedStyle(rail).overflowX).toBe('auto')
  })

  it('fills the available width at every message layer when fullWidth is enabled', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <div data-testid="drawer-body" style={{ width: 600 }}>
          <ChatMessageRenderer
            message={message}
            resultMap={new Map()}
            onOpenDrawer={() => {}}
            sessionId="session-1"
            fullWidth
          />
        </div>
      </I18nextProvider>,
    )

    const drawerBody = screen.getByTestId('drawer-body')
    const rendererRoot = drawerBody.firstElementChild as HTMLElement
    const messageRoot = rendererRoot.firstElementChild as HTMLElement
    const messageContent = messageRoot.firstElementChild as HTMLElement
    const availableWidth = drawerBody.getBoundingClientRect().width

    expect(rendererRoot.getBoundingClientRect().width).toBeCloseTo(availableWidth, 0)
    expect(messageRoot.getBoundingClientRect().width).toBeCloseTo(availableWidth, 0)
    expect(messageContent.getBoundingClientRect().width).toBeCloseTo(availableWidth, 0)
  })

  it('animates process-region tool details when expanding and collapsing', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ChatMessageRenderer
          message={message}
          resultMap={new Map()}
          onOpenDrawer={() => {}}
          sessionId="session-1"
          animateCollapsibleItems
          lightweightToolHeaders
        />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /expand tool details/i }))
    const content = document.querySelector<HTMLElement>('[data-tool-content]')
    expect(content).not.toBeNull()
    expect(getComputedStyle(content!).animationName).toBe('process-item-expand')

    fireEvent.click(screen.getByRole('button', { name: /collapse tool details/i }))
    expect(content).toHaveAttribute('data-state', 'closed')
    expect(getComputedStyle(content!).animationName).toBe('process-item-collapse')
  })

  it('keeps the card-like tool style outside the process region', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ChatMessageRenderer
          message={message}
          resultMap={new Map()}
          onOpenDrawer={() => {}}
          sessionId="session-1"
        />
      </I18nextProvider>,
    )

    const toggle = screen.getByRole('button', { name: /expand tool details/i })
    const header = toggle.parentElement
    const tool = header?.parentElement
    expect(tool).toHaveClass('bg-surface-hover/30')
    expect(tool).not.toHaveClass('bg-transparent')
    expect(header).toHaveClass('p-2')
    expect(header).not.toHaveClass('p-0')
  })

  it('animates process-region thinking details when expanding and collapsing', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ChatMessageRenderer
          message={thinkingMessage}
          resultMap={new Map()}
          onOpenDrawer={() => {}}
          sessionId="session-1"
          animateCollapsibleItems
        />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /expand thoughts/i }))
    const content = document.querySelector<HTMLElement>('.animate-process-item')
    expect(content).not.toBeNull()
    expect(getComputedStyle(content!).animationName).toBe('process-item-expand')

    fireEvent.click(screen.getByRole('button', { name: /collapse thoughts/i }))
    expect(content).toHaveAttribute('data-state', 'closed')
    expect(getComputedStyle(content!).animationName).toBe('process-item-collapse')
  })
})
