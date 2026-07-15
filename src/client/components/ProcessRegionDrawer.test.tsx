import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import ProcessRegionDrawer from './ProcessRegionDrawer'
import type { ChatMessage } from '../types/message'
import i18n from '../i18n'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const assistantMsg: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  timestamp: 1,
  parts: [
    { type: 'thinking', text: 'hmm', state: 'complete' },
    { type: 'tool_use', toolUseId: 'Bash', toolName: 'Bash', input: {}, state: 'complete' },
    { type: 'text', text: 'done' },
  ],
}
// tool_result lives in a separate user message, re-linked by toolUseId.
const resultMsg: ChatMessage = {
  id: 'r1',
  role: 'user',
  timestamp: 2,
  parts: [{ type: 'tool_result', toolUseId: 'Bash', output: 'command output', isError: false }],
}

const mockStore = {
  messages: { s1: [assistantMsg, resultMsg] } as Record<string, ChatMessage[]>,
}
vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (s: typeof mockStore) => unknown) => selector(mockStore),
}))

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('ProcessRegionDrawer', () => {
  it('renders one region linearly, links its tool_result, closes on Escape (AE4/R11/R12)', () => {
    const onClose = vi.fn()
    renderWithI18n(
      <ProcessRegionDrawer
        messageId="m1"
        regionIndex={0}
        sessionId="s1"
        width={400}
        onClose={onClose}
        onWidthChange={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog')
    // Region 0 = [thinking, tool_use]; its tool name + linked result appear...
    expect(dialog).toHaveTextContent('Bash')
    expect(dialog).toHaveTextContent('command output')
    // ...and the text part (region 1) is NOT part of this region.
    expect(dialog).not.toHaveTextContent('done')

    // Escape closes the drawer.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
