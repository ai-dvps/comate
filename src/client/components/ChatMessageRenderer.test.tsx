import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import ChatMessageRenderer, {
  type RenderableMessage,
} from './ChatMessageRenderer'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

function makeTextMessage(text: string, role: 'user' | 'assistant' | 'system' = 'assistant'): RenderableMessage {
  return {
    id: 'msg-1',
    role,
    parts: [{ type: 'text', text }],
  }
}

const noop = () => {}

const baseProps = {
  resultMap: new Map(),
  onOpenDrawer: noop,
  sessionId: 'session-1',
}

describe('ChatMessageRenderer search highlights', () => {
  it('renders inline highlights for user text', () => {
    const message = makeTextMessage('hello world', 'user')
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 6, end: 11 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const active = document.querySelector('[data-search-active="true"]')
    expect(active).toHaveTextContent('world')
  })

  it('renders inline highlights for system text', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'system',
      parts: [{ type: 'text', text: 'system warning' }],
    }
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 7, end: 14 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const active = document.querySelector('[data-search-active="true"]')
    expect(active).toHaveTextContent('warning')
  })

  it('auto-expands assistant text when current match is inside', () => {
    const message = makeTextMessage('hello world', 'assistant')
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 6, end: 11 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('marks tool input/output code blocks when they match', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'read_file',
          input: { path: '/config.json' },
          isStreaming: false,
        },
      ],
    }
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 0, end: 6 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const container = document.querySelector('[data-language="json"]')
    expect(container).toHaveClass('ring-1')
  })

  it('marks reasoning blocks when they match', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'thinking', text: 'thinking about config', isStreaming: false }],
    }
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 16, end: 22 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const content = screen.getByText('thinking about config')
    expect(content).toBeInTheDocument()
  })
})
