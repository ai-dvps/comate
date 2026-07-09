import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import SubagentDrawer from './SubagentDrawer'
import i18n from '../i18n'
import type { SubagentState } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const mockStore: {
  subagents: Record<string, SubagentState[]>
  messages: Record<string, { parts: unknown[] }[]>
} = {
  subagents: {},
  messages: {},
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockStore) => unknown) =>
    selector(mockStore),
}))

describe('SubagentDrawer', () => {
  beforeEach(() => {
    mockStore.subagents = {}
    mockStore.messages = {}
  })

  it('renders a placeholder when no subagent state exists', () => {
    renderWithI18n(
      <SubagentDrawer
        parentToolUseId="tu-1"
        sessionId="s1"
        width={300}
        onClose={() => {}}
        onWidthChange={() => {}}
      />,
    )

    expect(screen.getByText('Agent')).toBeInTheDocument()
    expect(screen.getByText('Launched in background. You can keep working.')).toBeInTheDocument()
  })

  it('shows the async-launched badge when only async metadata is present', () => {
    mockStore.messages['s1'] = [
      {
        parts: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Async agent launched successfully',
            isError: false,
            toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
          },
        ],
      },
    ]

    renderWithI18n(
      <SubagentDrawer
        parentToolUseId="tu-1"
        sessionId="s1"
        width={300}
        onClose={() => {}}
        onWidthChange={() => {}}
      />,
    )

    expect(screen.getByText('Async')).toBeInTheDocument()
  })

  it('shows the running-in-background badge after subagent deltas arrived', () => {
    mockStore.subagents['s1'] = [
      {
        parentToolUseId: 'tu-1',
        state: 'running',
        startTime: Date.now(),
        description: 'Research',
        toolCount: 1,
        progressHint: '',
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Started' }],
          },
        ],
      },
    ]
    mockStore.messages['s1'] = [
      {
        parts: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Async agent launched successfully',
            isError: false,
            toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
          },
        ],
      },
    ]

    renderWithI18n(
      <SubagentDrawer
        parentToolUseId="tu-1"
        sessionId="s1"
        width={300}
        onClose={() => {}}
        onWidthChange={() => {}}
      />,
    )

    expect(screen.getByText('Running in background')).toBeInTheDocument()
  })
})
