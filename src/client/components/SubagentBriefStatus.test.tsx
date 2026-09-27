import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import SubagentBriefStatus from './SubagentBriefStatus'
import i18n from '../i18n'
import type { SubagentState } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

function makeSubagent(overrides: Partial<SubagentState> = {}): SubagentState {
  return {
    parentToolUseId: 'tu-1',
    state: 'running',
    startTime: Date.now(),
    endTime: undefined,
    toolCount: 0,
    progressHint: '',
    description: '',
    messages: [],
    ...overrides,
  }
}

const mockStore = {
  subagents: {} as Record<string, SubagentState[]>,
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockStore) => unknown) =>
    selector(mockStore),
}))

describe('SubagentBriefStatus', () => {
  beforeEach(() => {
    mockStore.subagents = {}
  })

  it('renders elapsed time and tool count in sub-header when subagent has no content', () => {
    mockStore.subagents['session-1'] = [
      makeSubagent({ startTime: Date.now() }),
    ]

    renderWithI18n(
      <SubagentBriefStatus
        parentToolUseId="tu-1"
        sessionId="session-1"
        onOpenDrawer={() => {}}
      />,
    )

    expect(screen.getByText('0s')).toBeInTheDocument()
    expect(screen.getByText('0 tools')).toBeInTheDocument()
    expect(screen.queryByText('Show details')).not.toBeInTheDocument()
  })

  it('shows description in body without a duplicate elapsed/tools row', () => {
    mockStore.subagents['session-1'] = [
      makeSubagent({
        startTime: Date.now(),
        description: 'Researching best practices',
        toolCount: 2,
      }),
    ]

    renderWithI18n(
      <SubagentBriefStatus
        parentToolUseId="tu-1"
        sessionId="session-1"
        onOpenDrawer={() => {}}
      />,
    )

    expect(screen.getByText('0s')).toBeInTheDocument()
    expect(screen.getByText('2 tools')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Show details'))

    expect(screen.getByText('Researching best practices')).toBeInTheDocument()
    expect(screen.getAllByText('0s')).toHaveLength(1)
    expect(screen.getAllByText('2 tools')).toHaveLength(1)
  })

  it('renders final elapsed time and tool count for a completed subagent', () => {
    mockStore.subagents['session-1'] = [
      makeSubagent({
        state: 'completed',
        startTime: Date.now() - 5000,
        endTime: Date.now(),
        toolCount: 3,
      }),
    ]

    renderWithI18n(
      <SubagentBriefStatus
        parentToolUseId="tu-1"
        sessionId="session-1"
        onOpenDrawer={() => {}}
      />,
    )

    expect(screen.getByText('5s')).toBeInTheDocument()
    expect(screen.getByText('3 tools')).toBeInTheDocument()
  })

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('updates elapsed time while the subagent is running', async () => {
      mockStore.subagents['session-1'] = [
        makeSubagent({ startTime: Date.now() }),
      ]

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
        />,
      )

      expect(screen.getByText('0s')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(screen.getByText('1s')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(screen.getByText('3s')).toBeInTheDocument()
    })

    it('freezes elapsed time at endTime for a completed subagent', async () => {
      vi.setSystemTime(new Date('2026-06-20T10:00:10.000Z'))
      mockStore.subagents['session-1'] = [
        makeSubagent({
          state: 'completed',
          startTime: Date.now() - 10000,
          endTime: Date.now() - 2000,
          toolCount: 3,
        }),
      ]

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
        />,
      )

      expect(screen.getByText('8s')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(screen.getByText('8s')).toBeInTheDocument()
    })
  })

  describe('async lifecycle', () => {
    it('renders async-launched badge and hides raw placeholder output when no subagent exists', () => {
      mockStore.subagents['session-1'] = []

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
          result={{
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Async agent launched successfully',
            isError: false,
            toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
          }}
        />,
      )

      expect(screen.getByText('Async', { selector: '[class*="inline-flex"]' })).toBeInTheDocument()
      expect(
        screen.queryByText('Async agent launched successfully'),
      ).not.toBeInTheDocument()
    })

    it('renders running-in-background badge after the first subagent delta', () => {
      mockStore.subagents['session-1'] = [
        makeSubagent({
          state: 'running',
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Started' }],
            },
          ],
        }),
      ]

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
          result={{
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Async agent launched successfully',
            isError: false,
            toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
          }}
        />,
      )

      expect(screen.getByText('Running in background', { selector: '[class*="inline-flex"]' })).toBeInTheDocument()
    })

    it('does not render inline result preview for completed state', () => {
      mockStore.subagents['session-1'] = [
        makeSubagent({
          state: 'completed',
          endTime: Date.now(),
        }),
      ]

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
          result={{
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Final collected result',
            isError: false,
            toolUseResult: { status: 'completed' },
          }}
        />,
      )

      expect(screen.getByText('Completed', { selector: '[class*="inline-flex"]' })).toBeInTheDocument()
      expect(screen.queryByText('Final collected result')).not.toBeInTheDocument()
    })

    it('does not render inline error preview for error state', () => {
      mockStore.subagents['session-1'] = [
        makeSubagent({
          state: 'error',
          endTime: Date.now(),
        }),
      ]

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
          result={{
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Something went wrong',
            isError: true,
          }}
        />,
      )

      expect(screen.getByText('Error', { selector: '[class*="inline-flex"]' })).toBeInTheDocument()
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
    })

    it('announces the async badge via aria-live', () => {
      mockStore.subagents['session-1'] = []

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
          result={{
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Async agent launched successfully',
            isError: false,
            toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
          }}
        />,
      )

      expect(screen.getByText('Async', { selector: '[aria-live="polite"]' })).toBeInTheDocument()
    })

    it('gives the Open panel button an accessible name', () => {
      mockStore.subagents['session-1'] = []

      renderWithI18n(
        <SubagentBriefStatus
          parentToolUseId="tu-1"
          sessionId="session-1"
          onOpenDrawer={() => {}}
          result={{
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'Async agent launched successfully',
            isError: false,
            toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
          }}
        />,
      )

      expect(
        screen.getByRole('button', { name: 'Open panel' }),
      ).toHaveAttribute('aria-expanded', 'false')
    })
  })
})
