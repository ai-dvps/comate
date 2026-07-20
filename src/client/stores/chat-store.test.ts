import { describe, it, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import assert from 'node:assert'
import {
  normalizeSdkStatus,
  sanitizeSubagents,
  useChatStore,
  handleSseEvent,
  handleWsEvent,
  getLastEventId,
  clearLastEventId,
  clearAllSessionSubscriptions,
  deriveInFlightBrowserToolIds,
  type SseSetter,
} from './chat-store'
import { DEFAULT_TIMEOUT, wsClient } from '../lib/websocket-client'
import { useToastStore } from './toast-store'
import type { SubagentState, TaskItem, WorkflowState, WorkflowStatus } from '../types/message'
import type { WsEventMessage } from '@server/websocket/types'

describe('normalizeSdkStatus', () => {
  it('preserves valid TaskItem statuses', () => {
    const valid: TaskItem['status'][] = [
      'pending',
      'in_progress',
      'completed',
      'failed',
      'killed',
      'paused',
    ]
    for (const status of valid) {
      assert.strictEqual(normalizeSdkStatus(status), status)
    }
  })

  it('maps SDK running alias to in_progress', () => {
    assert.strictEqual(normalizeSdkStatus('running'), 'in_progress')
  })

  it('falls back to pending for unknown statuses', () => {
    assert.strictEqual(normalizeSdkStatus('deleted'), 'pending')
    assert.strictEqual(normalizeSdkStatus(''), 'pending')
    assert.strictEqual(normalizeSdkStatus('nonsense'), 'pending')
  })
})

describe('sanitizeSubagents', () => {
  it('keeps valid subagent states', () => {
    const valid: SubagentState = {
      parentToolUseId: 'tool-1',
      description: 'Agent',
      state: 'completed',
      startTime: 1,
      endTime: 2,
      toolCount: 0,
      progressHint: '',
      messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
    }
    assert.deepStrictEqual(sanitizeSubagents([valid]), [valid])
  })

  it('drops entries with missing fields or invalid state', () => {
    const invalid = [
      { parentToolUseId: 123, state: 'completed' },
      { parentToolUseId: 'tool-2', state: 'unknown', startTime: 1, toolCount: 0, progressHint: '', description: '', messages: [] },
      { parentToolUseId: 'tool-3', state: 'running', startTime: 1, toolCount: 0, progressHint: '', description: 'Agent', messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }] },
    ]
    const result = sanitizeSubagents(invalid)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].parentToolUseId, 'tool-3')
  })

  it('filters malformed message parts', () => {
    const raw = [
      {
        parentToolUseId: 'tool-1',
        description: 'Agent',
        state: 'completed',
        startTime: 1,
        toolCount: 0,
        progressHint: '',
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [
              { type: 'text', text: 'hi' },
              { type: 'tool_use', toolUseId: 'tool-x', toolName: 'Bash', input: {} },
              { type: 'unknown', value: 1 },
            ],
          },
        ],
      },
    ]
    const result = sanitizeSubagents(raw)
    assert.strictEqual(result[0].messages[0].parts.length, 2)
  })
})

describe('loadMessages subagent hydration', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: { 'ws-1': [{ id: 's1', workspaceId: 'ws-1', name: 'Test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] },
      messages: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
    })
  })

  it('hydrates subagents from the server response', async () => {
    const subagent: SubagentState = {
      parentToolUseId: 'tool-1',
      description: 'Agent',
      state: 'completed',
      startTime: 1,
      endTime: 2,
      toolCount: 0,
      progressHint: '',
      messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
    }
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [], tasks: [], subagents: [subagent] })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState().subagents['s1']
      assert.ok(state)
      assert.strictEqual(state.length, 1)
      assert.strictEqual(state[0].parentToolUseId, 'tool-1')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('preserves live running subagents and skips historical data for the same parentToolUseId', async () => {
    const live: SubagentState = {
      parentToolUseId: 'tool-1',
      description: 'Live Agent',
      state: 'running',
      startTime: 1,
      toolCount: 1,
      progressHint: 'working',
      messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'streaming' }] }],
    }
    const historical: SubagentState = {
      parentToolUseId: 'tool-1',
      description: 'Historical Agent',
      state: 'completed',
      startTime: 0,
      endTime: 1,
      toolCount: 0,
      progressHint: '',
      messages: [{ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'old' }] }],
    }
    const other: SubagentState = {
      parentToolUseId: 'tool-2',
      description: 'Other Agent',
      state: 'completed',
      startTime: 1,
      endTime: 2,
      toolCount: 0,
      progressHint: '',
      messages: [{ id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'other' }] }],
    }

    useChatStore.setState({ subagents: { s1: [live] } })

    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [], tasks: [], subagents: [historical, other] })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState().subagents['s1']
      assert.ok(state)
      assert.strictEqual(state.length, 2)
      const liveAfter = state.find((s) => s.parentToolUseId === 'tool-1')
      const otherAfter = state.find((s) => s.parentToolUseId === 'tool-2')
      assert.strictEqual(liveAfter?.state, 'running')
      assert.strictEqual(liveAfter?.description, 'Live Agent')
      assert.strictEqual(otherAfter?.state, 'completed')
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('loadMessages workflow hydration', () => {
  function makeHistoricalSubagent(parentToolUseId: string): SubagentState {
    return {
      parentToolUseId,
      description: 'Agent',
      state: 'running',
      startTime: 1,
      toolCount: 0,
      progressHint: '',
      messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
    }
  }

  beforeEach(() => {
    useChatStore.getState().clearMessages('s1')
    useChatStore.setState({
      sessions: { 'ws-1': [{ id: 's1', workspaceId: 'ws-1', name: 'Test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] },
      messages: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('hydrates completed workflows from the server response', async () => {
    const workflow: WorkflowState = {
      runId: 'wf-history-1',
      sessionId: 's1',
      toolUseId: 'tu-history-1',
      workflowName: 'history-workflow',
      status: 'completed',
      startTime: 1,
      agentCount: 1,
      phases: [],
      progress: [],
      subagents: [makeHistoricalSubagent('workflow:wf-history-1:a1')],
    }
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({
      messages: [],
      tasks: [],
      subagents: [],
      workflows: [workflow],
    })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState()
      assert.strictEqual(state.workflows['s1']?.length, 1)
      assert.strictEqual(state.workflows['s1'][0].runId, 'wf-history-1')
      assert.strictEqual(state.workflows['s1'][0].status, 'completed')
      assert.strictEqual(state.workflows['s1'][0].toolUseId, 'tu-history-1')
      assert.strictEqual(state.subagents['s1']?.length, 1)
      assert.strictEqual(state.subagents['s1'][0].parentToolUseId, 'workflow:wf-history-1:a1')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('starts polling for running workflows loaded from history', async () => {
    vi.useFakeTimers()

    const running: WorkflowState = {
      runId: 'wf-history-2',
      sessionId: 's1',
      status: 'running',
      startTime: 1,
      agentCount: 1,
      phases: [],
      progress: [],
      subagents: [],
    }
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ workflow: running }),
      }),
    ) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({
      messages: [],
      tasks: [],
      subagents: [],
      workflows: [running],
    })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      assert.strictEqual(useChatStore.getState().workflows['s1']?.length, 1)

      await vi.advanceTimersByTimeAsync(0)
      assert.strictEqual(fetchFn.mock.calls.length, 1)
      assert.ok((fetchFn.mock.calls[0][0] as string).includes('/workflows/wf-history-2'))
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('handleSseEvent context_usage', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      messages: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      contextUsage: {},
    })
  })

  it('updates contextUsage on context_usage event', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'context_usage', {
      totalTokens: 100,
      maxTokens: 200000,
      percentage: 5,
      categories: [{ name: 'messages', tokens: 100 }],
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.contextUsage['s1'].percentage, 5)
    assert.strictEqual(state.contextUsage['s1'].totalTokens, 100)
    assert.strictEqual(state.contextUsage['s1'].categories[0].name, 'messages')
  })

  it('clears contextUsage on compact_boundary', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      contextUsage: {
        s1: { totalTokens: 100, maxTokens: 200000, percentage: 80, categories: [] },
      },
    })
    handleSseEvent(set, 'ws-1', 's1', 'compact_boundary', {})
    const state = useChatStore.getState()
    assert.strictEqual(state.contextUsage['s1'], undefined)
  })

  it('overwrites previous contextUsage values', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      contextUsage: {
        s1: { totalTokens: 100, maxTokens: 200000, percentage: 80, categories: [] },
      },
    })
    handleSseEvent(set, 'ws-1', 's1', 'context_usage', {
      totalTokens: 10,
      maxTokens: 200000,
      percentage: 5,
      categories: [],
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.contextUsage['s1'].percentage, 5)
    assert.strictEqual(state.contextUsage['s1'].totalTokens, 10)
  })
})

describe('handleSseEvent approval_timeout', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      messages: {},
      subagents: {},
      workflows: {},
      tasks: {},
      approvalQueue: {},
    })
    useToastStore.setState({ toasts: [] })
  })

  it('surfaces a warning toast when a pending approval times out', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'approval_timeout', { requestId: 'req-1' })
    const toasts = useToastStore.getState().toasts
    assert.strictEqual(toasts.length, 1)
    assert.strictEqual(toasts[0].severity, 'warning')
    assert.ok(toasts[0].message.length > 0)
  })

  it('does not disturb the approval queue (approval_resolved removes the card)', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      approvalQueue: {
        s1: [{ requestId: 'req-1', toolName: 'Bash', toolUseId: 't1', input: {}, inputSummary: '' }],
      },
    })
    handleSseEvent(set, 'ws-1', 's1', 'approval_timeout', { requestId: 'req-1' })
    assert.strictEqual(useChatStore.getState().approvalQueue['s1'].length, 1)
    // The paired approval_resolved event is what dismisses the card.
    handleSseEvent(set, 'ws-1', 's1', 'approval_resolved', { requestId: 'req-1' })
    assert.strictEqual(useChatStore.getState().approvalQueue['s1'].length, 0)
  })
})

describe('bot session guards', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
    })
  })

  function makeSession(source: 'gui' | 'wecom' | 'feishu'): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Test',
      source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  it('sendMessage does not post to a Feishu bot session', () => {
    useChatStore.setState({
      sessions: { 'ws-1': [makeSession('feishu')] },
    })

    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      useChatStore.getState().sendMessage('ws-1', 's1', 'hello')
      assert.strictEqual(requestSpy.mock.calls.length, 0)
      assert.strictEqual(useChatStore.getState().messages['s1'], undefined)
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('sendMessage sends via WebSocket to a GUI session', async () => {
    useChatStore.setState({
      sessions: { 'ws-1': [makeSession('gui')] },
    })

    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      // Establish an active subscription so sendMessage sends directly.
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))
      useChatStore.setState({ serverNonce: { s1: 'nonce-1' } })
      requestSpy.mockClear()

      useChatStore.getState().sendMessage('ws-1', 's1', 'hello')
      assert.strictEqual(requestSpy.mock.calls.length, 1)
      assert.strictEqual(requestSpy.mock.calls[0][0], 'sendMessage')
      assert.strictEqual(useChatStore.getState().messages['s1']?.length, 1)
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('refreshBotMessages loads latest messages via WebSocket for a Feishu bot session', async () => {
    useChatStore.setState({
      sessions: { 'ws-1': [makeSession('feishu')] },
    })

    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [] })

    try {
      await useChatStore.getState().refreshBotMessages('ws-1', 's1')
      assert.strictEqual(requestSpy.mock.calls.length, 1)
      assert.strictEqual(requestSpy.mock.calls[0][0], 'loadMessagesAfter')
      const payload = requestSpy.mock.calls[0][1] as Record<string, unknown>
      assert.strictEqual(payload.workspaceId, 'ws-1')
      assert.strictEqual(payload.sessionId, 's1')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('refreshBotMessages does not request for a GUI session', async () => {
    useChatStore.setState({
      sessions: { 'ws-1': [makeSession('gui')] },
    })

    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [] })

    try {
      await useChatStore.getState().refreshBotMessages('ws-1', 's1')
      assert.strictEqual(requestSpy.mock.calls.length, 0)
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('setActiveSession subscribe timeout', () => {
  function makeGuiSession(): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Test',
      source: 'gui',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    useChatStore.setState({
      sessions: { 'ws-1': [makeGuiSession()] },
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
    })
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
  })

  it('uses DEFAULT_TIMEOUT for subscribe requests', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      // subscribeToSession fires and forgets doSubscribe(); give the microtask queue a turn.
      await new Promise((r) => setTimeout(r, 0))

      const subscribeCall = requestSpy.mock.calls.find((call) => call[0] === 'subscribe')
      assert.ok(subscribeCall, 'subscribe request should be sent')
      assert.strictEqual(subscribeCall[2], DEFAULT_TIMEOUT)
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('does not subscribe again when the session is already active', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      // Calling setActiveSession again with the same session should be a no-op
      // and must not tear down and recreate the subscription.
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      const subscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'subscribe')
      assert.strictEqual(subscribeCalls.length, 1, 'only one subscribe request should be sent')
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('setActiveSession multi-workspace re-subscribe', () => {
  function makeGuiSession(id: string, workspaceId: string): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id,
      workspaceId,
      name: 'Test',
      source: 'gui' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    // Tear down any subscriptions left over by earlier tests so this suite's
    // unsubscribe counts are deterministic.
    useChatStore.getState().cleanupWorkspace('ws-1')
    useChatStore.getState().cleanupWorkspace('ws-2')

    useChatStore.setState({
      sessions: {
        'ws-1': [makeGuiSession('s1', 'ws-1')],
        'ws-2': [makeGuiSession('s2', 'ws-2')],
      },
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
    })
  })

  it('re-subscribes when switching back to a workspace whose subscription was torn down', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      // Activate session in workspace 1.
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      // Simulate leaving workspace 1: its subscription is torn down.
      useChatStore.getState().cleanupWorkspace('ws-1')
      await new Promise((r) => setTimeout(r, 0))

      // Switch to workspace 2.
      useChatStore.getState().setActiveSession('ws-2', 's2')
      await new Promise((r) => setTimeout(r, 0))

      // Switch back to workspace 1: even though s1 is still the active session
      // for ws-1, its subscription was torn down, so we must re-subscribe.
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      const subscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'subscribe')
      assert.strictEqual(subscribeCalls.length, 3, 's1, s2, then s1 again')

      const payloads = subscribeCalls.map((call) => call[1] as Record<string, unknown>)
      assert.strictEqual(payloads[0].sessionId, 's1')
      assert.strictEqual(payloads[1].sessionId, 's2')
      assert.strictEqual(payloads[2].sessionId, 's1')

      const unsubscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'unsubscribe')
      const unsubscribeForS1 = unsubscribeCalls.find(
        (call) => (call[1] as Record<string, unknown>).sessionId === 's1',
      )
      assert.ok(unsubscribeForS1, 's1 unsubscribed when leaving ws-1')
      assert.strictEqual(unsubscribeCalls.length, 1, 'only the explicit workspace cleanup unsubscribes')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('does not re-subscribe when the same session is already subscribed', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      // Calling again without switching away must be a no-op.
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      const subscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'subscribe')
      assert.strictEqual(subscribeCalls.length, 1, 'only one subscribe request should be sent')
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('sendMessage subscription gating', () => {
  function makeGuiSession(): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Test',
      source: 'gui' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    useChatStore.setState({
      sessions: { 'ws-1': [makeGuiSession()] },
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
    })
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
  })

  it('queues sendMessage in pendingSend when the subscription lacks a server nonce', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      // Open a subscription but do not acknowledge it (no serverNonce).
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))
      requestSpy.mockClear()

      useChatStore.getState().sendMessage('ws-1', 's1', 'hello')
      await new Promise((r) => setTimeout(r, 0))

      const sendCalls = requestSpy.mock.calls.filter((call) => call[0] === 'sendMessage')
      assert.strictEqual(sendCalls.length, 0, 'must not send without a server nonce')
      assert.deepStrictEqual(useChatStore.getState().pendingSend['s1'], {
        workspaceId: 'ws-1',
        content: 'hello',
      })
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('does not send a second subscribe when sendMessage races with subscribeToSession', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return {}
    })

    try {
      // setActiveSession starts an async subscribe; sendMessage is called before
      // the subscribe promise resolves. sessionSubscriptions must already be set
      // so sendMessage does not spawn a duplicate subscription.
      useChatStore.getState().setActiveSession('ws-1', 's1')
      useChatStore.getState().sendMessage('ws-1', 's1', 'hello')
      await new Promise((r) => setTimeout(r, 20))

      const subscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'subscribe')
      assert.strictEqual(subscribeCalls.length, 1, 'only one subscribe request should be sent')
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('subscription state after disconnect', () => {
  function makeGuiSession(): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Test',
      source: 'gui' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    useChatStore.setState({
      sessions: { 'ws-1': [makeGuiSession()] },
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
    })
  })

  it('clears serverNonce for all sessions on disconnect so the next sendMessage re-subscribes', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ serverNonce: { s1: 'stale-nonce' } })

    clearAllSessionSubscriptions(set)

    assert.strictEqual(useChatStore.getState().serverNonce['s1'], undefined)
  })

  it('keeps lastEventId as the reconnect cursor after clearing subscriptions', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleWsEvent(set, useChatStore.getState, {
      type: 'event',
      eventType: 'sse',
      workspaceId: 'ws-1',
      sessionId: 's1',
      eventId: 'evt-keep',
      data: { type: 'text_delta', text: 'prior' },
    })

    clearAllSessionSubscriptions(set)

    assert.strictEqual(getLastEventId('s1'), 'evt-keep')
  })
})

describe('WebSocket event lastEventId tracking', () => {
  beforeEach(() => {
    clearLastEventId()
    useChatStore.setState({
      sessions: {},
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
    })
  })

  it('records the event id when an SSE event is received', () => {
    const set = useChatStore.setState as unknown as SseSetter
    const msg: WsEventMessage = {
      type: 'event',
      eventType: 'sse',
      workspaceId: 'ws-1',
      sessionId: 's1',
      eventId: 'evt-42',
      data: { type: 'text_delta', text: 'hello' },
    }
    handleWsEvent(set, useChatStore.getState, msg)
    assert.strictEqual(getLastEventId('s1'), 'evt-42')
  })

  it('ignores events without an event id', () => {
    const set = useChatStore.setState as unknown as SseSetter
    const msg: WsEventMessage = {
      type: 'event',
      eventType: 'sse',
      workspaceId: 'ws-1',
      sessionId: 's1',
      data: { type: 'text_delta', text: 'hello' },
    }
    handleWsEvent(set, useChatStore.getState, msg)
    assert.strictEqual(getLastEventId('s1'), undefined)
  })

  it('includes lastEventId in the subscribe request when one is known', async () => {
    const session = {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Test',
      source: 'gui' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // Simulate a prior event having set the cursor.
    const set = useChatStore.setState as unknown as SseSetter
    handleWsEvent(set, useChatStore.getState, {
      type: 'event',
      eventType: 'sse',
      workspaceId: 'ws-1',
      sessionId: 's1',
      eventId: 'evt-7',
      data: { type: 'text_delta', text: 'prior' },
    })

    useChatStore.setState({
      sessions: { 'ws-1': [session] },
      activeSessionIds: {},
    })

    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      const subscribeCall = requestSpy.mock.calls.find((call) => call[0] === 'subscribe')
      assert.ok(subscribeCall, 'subscribe request should be sent')
      const payload = subscribeCall[1] as Record<string, unknown>
      assert.strictEqual(payload.lastEventId, 'evt-7')
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('runtime_closed WebSocket event', () => {
  function makeGuiSession(): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Test',
      source: 'gui' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    clearLastEventId()
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
    useChatStore.setState({
      sessions: { 'ws-1': [makeGuiSession()] },
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
    })
  })

  it('clears subscription state so the next sendMessage re-subscribes', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})
    const set = useChatStore.setState as unknown as SseSetter

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))
      useChatStore.setState({ serverNonce: { s1: 'nonce-1' } })
      requestSpy.mockClear()

      // First message sends directly because the subscription is active.
      useChatStore.getState().sendMessage('ws-1', 's1', 'first')
      await new Promise((r) => setTimeout(r, 0))
      assert.strictEqual(
        requestSpy.mock.calls.filter((call) => call[0] === 'sendMessage').length,
        1,
        'first message should be sent',
      )

      // Server reports the runtime was closed (e.g. idle timeout).
      handleWsEvent(set, useChatStore.getState, {
        type: 'event',
        eventType: 'runtime_closed',
        workspaceId: 'ws-1',
        sessionId: 's1',
        data: {},
      })

      assert.strictEqual(useChatStore.getState().serverNonce['s1'], '')

      // The next message must re-subscribe before sending.
      requestSpy.mockClear()
      useChatStore.getState().sendMessage('ws-1', 's1', 'second')
      await new Promise((r) => setTimeout(r, 0))

      const subscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'subscribe')
      assert.strictEqual(subscribeCalls.length, 1, 'should re-subscribe after runtime_closed')
      assert.strictEqual(
        requestSpy.mock.calls.filter((call) => call[0] === 'sendMessage').length,
        0,
        'must not send until the new subscription is acknowledged',
      )
      assert.deepStrictEqual(useChatStore.getState().pendingSend['s1'], {
        workspaceId: 'ws-1',
        content: 'second',
      })
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('background session streaming', () => {
  function makeGuiSession(id: string, workspaceId: string): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id,
      workspaceId,
      name: 'Test',
      source: 'gui' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    clearLastEventId()
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
    useChatStore.setState({
      sessions: {
        'ws-1': [
          makeGuiSession('s1', 'ws-1'),
          makeGuiSession('s2', 'ws-1'),
          makeGuiSession('s3', 'ws-1'),
          makeGuiSession('s4', 'ws-1'),
          makeGuiSession('s5', 'ws-1'),
          makeGuiSession('s6', 'ws-1'),
        ],
      },
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
      backgroundSessions: {},
    })
  })

  it('keeps the previous session subscribed when switching to another session', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      useChatStore.getState().setActiveSession('ws-1', 's2')
      await new Promise((r) => setTimeout(r, 0))

      const subscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'subscribe')
      assert.strictEqual(subscribeCalls.length, 2, 'both sessions should be subscribed')

      const unsubscribeForS1 = requestSpy.mock.calls.find(
        (call) => call[0] === 'unsubscribe' && (call[1] as Record<string, unknown>).sessionId === 's1',
      )
      assert.strictEqual(unsubscribeForS1, undefined, 'must not tear down s1 when switching away')

      const state = useChatStore.getState()
      assert.ok(state.backgroundSessions['ws-1']?.includes('s1'))
      assert.ok(state.backgroundSessions['ws-1']?.includes('s2'))
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('adds a session to the background registry when it receives an SSE event', () => {
    const set = useChatStore.setState as unknown as SseSetter

    handleWsEvent(set, useChatStore.getState, {
      type: 'event',
      eventType: 'sse',
      workspaceId: 'ws-1',
      sessionId: 's1',
      eventId: 'evt-1',
      data: { type: 'text_delta', text: 'hello' },
    })

    assert.ok(useChatStore.getState().backgroundSessions['ws-1']?.includes('s1'))
  })

  it('removes a session from the background registry on runtime_closed and tears down its subscription', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})
    const set = useChatStore.setState as unknown as SseSetter

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))
      requestSpy.mockClear()

      handleWsEvent(set, useChatStore.getState, {
        type: 'event',
        eventType: 'runtime_closed',
        workspaceId: 'ws-1',
        sessionId: 's1',
        data: {},
      })

      const state = useChatStore.getState()
      assert.strictEqual(state.backgroundSessions['ws-1']?.includes('s1'), false)
      assert.strictEqual(state.serverNonce['s1'], '')

      const unsubscribeCalls = requestSpy.mock.calls.filter((call) => call[0] === 'unsubscribe')
      assert.strictEqual(unsubscribeCalls.length, 1)
      assert.strictEqual((unsubscribeCalls[0][1] as Record<string, unknown>).sessionId, 's1')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('evicts the oldest cached session from the background registry when the DOM cache overflows', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      for (const id of ['s1', 's2', 's3', 's4', 's5']) {
        useChatStore.getState().setActiveSession('ws-1', id)
        await new Promise((r) => setTimeout(r, 0))
      }

      requestSpy.mockClear()

      // Adding a sixth session pushes s1 out of the DOM cache.
      useChatStore.getState().setActiveSession('ws-1', 's6')
      await new Promise((r) => setTimeout(r, 0))

      const state = useChatStore.getState()
      assert.strictEqual(state.domCache['ws-1']?.length, 5)
      assert.strictEqual(state.domCache['ws-1']?.includes('s1'), false)
      assert.strictEqual(state.backgroundSessions['ws-1']?.includes('s1'), false)
      assert.ok(state.backgroundSessions['ws-1']?.includes('s6'))

      const unsubscribeForS1 = requestSpy.mock.calls.find(
        (call) => call[0] === 'unsubscribe' && (call[1] as Record<string, unknown>).sessionId === 's1',
      )
      assert.ok(unsubscribeForS1, 'evicted session should be unsubscribed')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('clears the background registry for a workspace on cleanupWorkspace', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})
    const set = useChatStore.setState as unknown as SseSetter

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((r) => setTimeout(r, 0))

      handleWsEvent(set, useChatStore.getState, {
        type: 'event',
        eventType: 'sse',
        workspaceId: 'ws-1',
        sessionId: 's2',
        eventId: 'evt-1',
        data: { type: 'text_delta', text: 'hello' },
      })

      assert.ok(useChatStore.getState().backgroundSessions['ws-1']?.includes('s2'))

      useChatStore.getState().cleanupWorkspace('ws-1')

      assert.strictEqual(useChatStore.getState().backgroundSessions['ws-1'], undefined)
    } finally {
      requestSpy.mockRestore()
    }
  })
})

describe('notification turn-timing metadata', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      messages: {},
      isStreaming: {},
      streamStartedAt: {},
      lastCompletion: {},
      totalMessageCount: {},
      sessionStatus: {},
      lastActivityAt: {},
      activeSessionIds: {},
      unreadCompletions: {},
    })
  })

  it('result records a non-error completion with a positive duration and clears the start timestamp', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ streamStartedAt: { s1: 1000 } })
    handleSseEvent(set, 'ws-1', 's1', 'result', {
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const completion = useChatStore.getState().lastCompletion['s1']
    assert.ok(completion, 'completion record written')
    assert.strictEqual(completion.isError, false)
    assert.ok(completion.durationMs > 0, 'duration is positive')
    assert.strictEqual(useChatStore.getState().streamStartedAt['s1'], 0, 'start timestamp cleared')
  })

  it('Covers AE6: result with isError records an error completion', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ streamStartedAt: { s1: 1000 } })
    handleSseEvent(set, 'ws-1', 's1', 'result', { isError: true })
    assert.strictEqual(useChatStore.getState().lastCompletion['s1'].isError, true)
  })

  it('records durationMs of 0 when no turn-start timestamp was captured', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'result', {})
    assert.strictEqual(useChatStore.getState().lastCompletion['s1'].durationMs, 0)
  })

  it('Covers reconnect-start: assistant_start recovers streamStartedAt from an existing message on replay', () => {
    const set = useChatStore.setState as unknown as SseSetter
    const msgTime = 12345
    useChatStore.setState({
      messages: {
        s1: [{ id: 'm1', role: 'assistant' as const, parts: [], timestamp: msgTime, isStreaming: false }],
      },
      streamStartedAt: {}, // fresh store — prompt-send was not replayed
    })
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    assert.strictEqual(useChatStore.getState().streamStartedAt['s1'], msgTime)
  })

  it('assistant_start does not overwrite an existing prompt-send timestamp', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      messages: {
        s1: [{ id: 'm1', role: 'assistant' as const, parts: [], timestamp: 999, isStreaming: false }],
      },
      streamStartedAt: { s1: 500 }, // prompt-send already captured the start
    })
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    assert.strictEqual(useChatStore.getState().streamStartedAt['s1'], 500)
  })
})

describe('setSessionProvider', () => {
  function makeGuiSession(): ReturnType<typeof useChatStore.getState>['sessions'][string][number] {
    return {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Test',
      source: 'gui',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  let requestSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({}),
        }),
      ) as unknown as typeof fetch,
    )
    useChatStore.setState({
      sessions: { 'ws-1': [makeGuiSession()] },
      activeSessionIds: {},
      messages: {},
      drafts: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
      isRestartingRuntime: {},
    })
    // Clear any lingering subscriptions from other test suites.
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
  })

  afterEach(() => {
    requestSpy.mockRestore()
    vi.unstubAllGlobals()
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
  })

  it('re-subscribes and clears loading after a provider switch for an active session', async () => {
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((r) => setTimeout(r, 0))

    requestSpy.mockClear()

    await useChatStore.getState().setSessionProvider('ws-1', 's1', 'p2')
    await new Promise((r) => setTimeout(r, 0))

    const subscribeCalls = requestSpy.mock.calls.filter((call: unknown[]) => call[0] === 'subscribe')
    assert.strictEqual(subscribeCalls.length, 1, 'should resubscribe after provider switch')
    assert.strictEqual(useChatStore.getState().isRestartingRuntime['s1'], false)
  })

  it('does not enter a loading state when there is no active subscription', async () => {
    await useChatStore.getState().setSessionProvider('ws-1', 's1', 'p2')
    await new Promise((r) => setTimeout(r, 0))

    const subscribeCalls = requestSpy.mock.calls.filter((call: unknown[]) => call[0] === 'subscribe')
    assert.strictEqual(subscribeCalls.length, 0, 'should not subscribe when no active runtime')
    assert.strictEqual(useChatStore.getState().isRestartingRuntime['s1'], undefined)
  })

  it('clears loading even if the post-switch subscribe fails', async () => {
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((r) => setTimeout(r, 0))

    requestSpy.mockImplementation(async (type: string) => {
      if (type === 'subscribe') {
        throw new Error('subscribe failed')
      }
      return {}
    })

    await useChatStore.getState().setSessionProvider('ws-1', 's1', 'p2')
    await new Promise((r) => setTimeout(r, 0))

    assert.strictEqual(useChatStore.getState().isRestartingRuntime['s1'], false)
  })
})

describe('workflow state', () => {
  function makeSubagent(parentToolUseId: string): SubagentState {
    return {
      parentToolUseId,
      description: 'Agent',
      state: 'running',
      startTime: 1,
      toolCount: 0,
      progressHint: '',
      messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
    }
  }

  function stubFetchWorkflow(workflow?: WorkflowState) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({ workflow }),
        }),
      ) as unknown as typeof fetch,
    )
  }

  beforeEach(() => {
    // Tear down any workflow polling left over by earlier tests.
    useChatStore.getState().clearMessages('s1')
    useChatStore.setState({
      sessions: {},
      messages: {},
      subagents: {},
      workflows: {},
      tasks: {},
      isLoadingMessages: {},
      totalMessageCount: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('workflow_start adds a placeholder and fetches initial state', async () => {
    const workflow: WorkflowState = {
      runId: 'wf-1',
      sessionId: 's1',
      toolUseId: 'tu-1',
      workflowName: 'deep-research',
      status: 'running',
      startTime: 123,
      agentCount: 1,
      phases: [],
      progress: [],
      subagents: [makeSubagent('workflow:wf-1:a1')],
    }
    stubFetchWorkflow(workflow)

    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_start', {
      runId: 'wf-1',
      sessionId: 's1',
      toolUseId: 'tu-1',
      workflowName: 'deep-research',
    })

    await new Promise((r) => setTimeout(r, 0))

    const state = useChatStore.getState()
    assert.strictEqual(state.workflows['s1']?.length, 1)
    assert.strictEqual(state.workflows['s1'][0].runId, 'wf-1')
    assert.strictEqual(state.workflows['s1'][0].status, 'running')
    assert.strictEqual(state.workflows['s1'][0].toolUseId, 'tu-1')
    assert.strictEqual(state.workflows['s1'][0].workflowName, 'deep-research')
    assert.strictEqual(state.subagents['s1']?.length, 1)
    assert.strictEqual(state.subagents['s1'][0].parentToolUseId, 'workflow:wf-1:a1')

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    assert.strictEqual(fetchCalls.length, 1)
    assert.ok((fetchCalls[0][0] as string).includes('/workflows/wf-1'))
  })

  it('workflow_update merges fetched state without duplicating workflows', async () => {
    const placeholder: WorkflowState = {
      runId: 'wf-1',
      sessionId: 's1',
      status: 'running',
      startTime: 1,
      agentCount: 0,
      phases: [],
      progress: [],
      subagents: [],
    }
    useChatStore.setState({ workflows: { s1: [placeholder] } })

    const updated: WorkflowState = {
      ...placeholder,
      agentCount: 2,
      subagents: [makeSubagent('workflow:wf-1:a2')],
    }
    stubFetchWorkflow(updated)

    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_update', { runId: 'wf-1', sessionId: 's1' })

    await new Promise((r) => setTimeout(r, 0))

    const state = useChatStore.getState()
    assert.strictEqual(state.workflows['s1']?.length, 1)
    assert.strictEqual(state.workflows['s1'][0].agentCount, 2)
    assert.strictEqual(state.subagents['s1']?.length, 1)
    assert.strictEqual(state.subagents['s1'][0].parentToolUseId, 'workflow:wf-1:a2')
  })

  it('workflow_done transitions status and stops polling', async () => {
    vi.useFakeTimers()

    const running: WorkflowState = {
      runId: 'wf-1',
      sessionId: 's1',
      status: 'running',
      startTime: 1,
      agentCount: 1,
      phases: [],
      progress: [],
      subagents: [],
    }

    let workflowStatus: WorkflowStatus = 'running'
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ workflow: { ...running, status: workflowStatus } }),
      }),
    ) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_start', { runId: 'wf-1', sessionId: 's1' })

    await vi.advanceTimersByTimeAsync(0)
    assert.strictEqual(fetchFn.mock.calls.length, 1)

    await vi.advanceTimersByTimeAsync(2500)
    assert.strictEqual(fetchFn.mock.calls.length, 2)

    workflowStatus = 'completed'
    handleSseEvent(set, 'ws-1', 's1', 'workflow_done', {
      runId: 'wf-1',
      sessionId: 's1',
      status: 'completed',
    })

    await vi.advanceTimersByTimeAsync(0)
    assert.strictEqual(fetchFn.mock.calls.length, 3)
    assert.strictEqual(useChatStore.getState().workflows['s1'][0].status, 'completed')

    await vi.advanceTimersByTimeAsync(2500)
    assert.strictEqual(fetchFn.mock.calls.length, 3)
  })

  it('clearMessages removes workflows and stops polling', async () => {
    vi.useFakeTimers()
    stubFetchWorkflow(undefined)

    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_start', { runId: 'wf-1', sessionId: 's1' })

    await vi.advanceTimersByTimeAsync(0)
    assert.ok(useChatStore.getState().workflows['s1'])

    useChatStore.getState().clearMessages('s1')

    assert.strictEqual(useChatStore.getState().workflows['s1'], undefined)

    const fetchFn = globalThis.fetch as ReturnType<typeof vi.fn>
    const countAfterClear = fetchFn.mock.calls.length

    await vi.advanceTimersByTimeAsync(3000)
    assert.strictEqual(fetchFn.mock.calls.length, countAfterClear)
  })

  it('workflow_update is ignored when the workflow is already terminal', async () => {
    vi.useFakeTimers()
    stubFetchWorkflow(undefined)

    const completed: WorkflowState = {
      runId: 'wf-1',
      sessionId: 's1',
      status: 'completed',
      startTime: 1,
      agentCount: 0,
      phases: [],
      progress: [],
      subagents: [],
    }
    useChatStore.setState({ workflows: { s1: [completed] } })

    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_update', { runId: 'wf-1', sessionId: 's1' })

    await vi.advanceTimersByTimeAsync(3000)

    const fetchFn = globalThis.fetch as ReturnType<typeof vi.fn>
    assert.strictEqual(fetchFn.mock.calls.length, 0)
  })

  it('session switch cleanup stops workflow polling', async () => {
    vi.useFakeTimers()
    stubFetchWorkflow(undefined)

    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_start', { runId: 'wf-1', sessionId: 's1' })

    await vi.advanceTimersByTimeAsync(0)
    const fetchFn = globalThis.fetch as ReturnType<typeof vi.fn>
    assert.strictEqual(fetchFn.mock.calls.length, 1)

    clearAllSessionSubscriptions(set)

    await vi.advanceTimersByTimeAsync(5000)
    assert.strictEqual(fetchFn.mock.calls.length, 1)
  })

  it('workflow_done fetches final state even when polling was already stopped', async () => {
    const final: WorkflowState = {
      runId: 'wf-1',
      sessionId: 's1',
      status: 'completed',
      startTime: 1,
      agentCount: 1,
      phases: [],
      progress: [],
      subagents: [],
    }
    stubFetchWorkflow(final)

    const running: WorkflowState = { ...final, status: 'running' }
    useChatStore.setState({ workflows: { s1: [running] } })

    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_done', {
      runId: 'wf-1',
      sessionId: 's1',
      status: 'completed',
    })

    await new Promise((r) => setTimeout(r, 0))

    const state = useChatStore.getState()
    assert.strictEqual(state.workflows['s1'][0].status, 'completed')
    const fetchFn = globalThis.fetch as ReturnType<typeof vi.fn>
    assert.strictEqual(fetchFn.mock.calls.length, 1)
  })

  it('multiple workflows in the same session are tracked independently', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'workflow_start', { runId: 'wf-1', sessionId: 's1' })
    handleSseEvent(set, 'ws-1', 's1', 'workflow_start', { runId: 'wf-2', sessionId: 's1' })

    const state = useChatStore.getState()
    assert.strictEqual(state.workflows['s1']?.length, 2)
    assert.ok(state.workflows['s1'].find((w) => w.runId === 'wf-1'))
    assert.ok(state.workflows['s1'].find((w) => w.runId === 'wf-2'))
  })
})

describe('task scanning and filtering', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: { 'ws-1': [{ id: 's1', workspaceId: 'ws-1', name: 'Test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] },
      messages: {},
      subagents: {},
      workflows: {},
      tasks: {},
      pendingTaskCreates: {},
      isLoadingMessages: {},
      totalMessageCount: {},
    })
  })

  function makeTodoWriteMessage(): { id: string; role: 'assistant'; timestamp: number; parts: unknown[] } {
    return {
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tool-todo',
          toolName: 'TodoWrite',
          input: { todos: [{ content: 'Buy milk', status: 'in_progress' }] },
        },
      ],
    }
  }

  function makeTaskCreateMessages(): { id: string; role: 'assistant'; timestamp: number; parts: unknown[] } {
    return {
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tool-create',
          toolName: 'TaskCreate',
          input: { subject: 'Write tests', activeForm: 'Planning test cases' },
        },
        {
          type: 'tool_result',
          toolUseId: 'tool-create',
          output: JSON.stringify({ task: { id: 'task-1', subject: 'Write tests' } }),
          isError: false,
        },
      ],
    }
  }

  function makeInternalTaskCreateMessages(): { id: string; role: 'assistant'; timestamp: number; parts: unknown[] } {
    return {
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tool-create-internal',
          toolName: 'TaskCreate',
          input: { subject: 'Reading src/client/components/ChatPanel.tsx', metadata: { _internal: true } },
        },
        {
          type: 'tool_result',
          toolUseId: 'tool-create-internal',
          output: JSON.stringify({ task: { id: 'task-internal', subject: 'Reading src/client/components/ChatPanel.tsx' } }),
          isError: false,
        },
      ],
    }
  }

  function makeTaskUpdateMessages(): { id: string; role: 'assistant'; timestamp: number; parts: unknown[] } {
    return {
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tool-create',
          toolName: 'TaskCreate',
          input: { subject: 'Write tests' },
        },
        {
          type: 'tool_result',
          toolUseId: 'tool-create',
          output: JSON.stringify({ task: { id: 'task-1', subject: 'Write tests' } }),
          isError: false,
        },
        {
          type: 'tool_use',
          toolUseId: 'tool-update',
          toolName: 'TaskUpdate',
          input: { taskId: 'task-1', status: 'completed' },
        },
      ],
    }
  }

  it('loadMessages filters out TodoWrite entries from tasks', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [makeTodoWriteMessage()], tasks: [], subagents: [] })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState()
      assert.deepStrictEqual(state.tasks['s1'], [])
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('loadMessages defensively filters todowrite-* server tasks', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({
      messages: [],
      tasks: [{ id: 'todowrite-0', subject: 'Server todo', status: 'in_progress' }],
      subagents: [],
    })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState()
      assert.deepStrictEqual(state.tasks['s1'], [])
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('loadMessages filters out TaskCreate entries marked as internal', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [makeInternalTaskCreateMessages()], tasks: [], subagents: [] })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState()
      assert.deepStrictEqual(state.tasks['s1'], [])
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('loadMessages creates tasks from TaskCreate + tool_result', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [makeTaskCreateMessages()], tasks: [], subagents: [] })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState()
      assert.strictEqual(state.tasks['s1']?.length, 1)
      assert.strictEqual(state.tasks['s1'][0].id, 'task-1')
      assert.strictEqual(state.tasks['s1'][0].subject, 'Write tests')
      assert.strictEqual(state.tasks['s1'][0].activeForm, 'Planning test cases')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('loadMessages updates existing task via TaskUpdate', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ messages: [makeTaskUpdateMessages()], tasks: [], subagents: [] })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState()
      assert.strictEqual(state.tasks['s1'][0].status, 'completed')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('live TodoWrite tool_use_done does not modify tasks', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ tasks: { s1: [{ id: 'task-1', subject: 'Existing task', status: 'in_progress' }] } })

    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 'tool-todo',
      toolName: 'TodoWrite',
    })

    handleSseEvent(set, 'ws-1', 's1', 'tool_use_done', {
      toolUseId: 'tool-todo',
      input: { todos: [{ content: 'Buy milk', status: 'in_progress' }] },
    })

    const state = useChatStore.getState()
    assert.strictEqual(state.tasks['s1']?.length, 1)
    assert.strictEqual(state.tasks['s1'][0].id, 'task-1')
  })

  it('live TaskCreate tool_use_done stores pending task create', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 'tool-create',
      toolName: 'TaskCreate',
    })

    handleSseEvent(set, 'ws-1', 's1', 'tool_use_done', {
      toolUseId: 'tool-create',
      input: { subject: 'Write tests', activeForm: 'Planning test cases' },
    })

    const state = useChatStore.getState()
    assert.ok(state.pendingTaskCreates['s1']?.['tool-create'])
    assert.strictEqual(state.pendingTaskCreates['s1']['tool-create'].subject, 'Write tests')
    assert.strictEqual(state.pendingTaskCreates['s1']['tool-create'].activeForm, 'Planning test cases')
  })

  it('live internal TaskCreate tool_use_done does not store pending task create', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 'tool-create-internal',
      toolName: 'TaskCreate',
    })

    handleSseEvent(set, 'ws-1', 's1', 'tool_use_done', {
      toolUseId: 'tool-create-internal',
      input: { subject: 'Reading src/client/components/ChatPanel.tsx', metadata: { _internal: true } },
    })

    const state = useChatStore.getState()
    assert.strictEqual(state.pendingTaskCreates['s1']?.['tool-create-internal'], undefined)
  })
})

describe('handleSseEvent tool_result replacement', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: {}, totalMessageCount: {} })
  })

  it('replaces an async-placeholder tool_result with the final result', () => {
    const set = useChatStore.setState as unknown as SseSetter

    handleSseEvent(set, 'ws-1', 's1', 'tool_result', {
      toolUseId: 'tu-agent-1',
      output: 'Async agent launched successfully',
      isError: false,
      toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
    })

    const afterPlaceholder = useChatStore.getState()
    assert.strictEqual(afterPlaceholder.messages['s1'].length, 1)
    const placeholderPart = afterPlaceholder.messages['s1'][0].parts[0]
    assert.strictEqual(placeholderPart.type, 'tool_result')
    assert.deepStrictEqual(
      (placeholderPart as { toolUseResult?: unknown }).toolUseResult,
      { status: 'async_launched', agentId: 'agent-1' },
    )

    handleSseEvent(set, 'ws-1', 's1', 'tool_result', {
      toolUseId: 'tu-agent-1',
      output: 'Final collected result',
      isError: false,
      toolUseResult: { status: 'completed' },
    })

    const afterFinal = useChatStore.getState()
    assert.strictEqual(afterFinal.messages['s1'].length, 1)
    const finalPart = afterFinal.messages['s1'][0].parts[0]
    assert.strictEqual(finalPart.type, 'tool_result')
    assert.strictEqual((finalPart as { output: string }).output, 'Final collected result')
    assert.deepStrictEqual(
      (finalPart as { toolUseResult?: unknown }).toolUseResult,
      { status: 'completed' },
    )
  })

  it('skips duplicate tool_result for non-async results', () => {
    const set = useChatStore.setState as unknown as SseSetter

    handleSseEvent(set, 'ws-1', 's1', 'tool_result', {
      toolUseId: 'tu-sync-1',
      output: 'First result',
      isError: false,
    })

    handleSseEvent(set, 'ws-1', 's1', 'tool_result', {
      toolUseId: 'tu-sync-1',
      output: 'Duplicate result',
      isError: false,
    })

    const state = useChatStore.getState()
    assert.strictEqual(state.messages['s1'].length, 1)
    assert.strictEqual(
      (state.messages['s1'][0].parts[0] as { output: string }).output,
      'First result',
    )
  })
})

describe('session_processing authoritative slice (U3)', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        'ws-1': [
          {
            id: 's1',
            workspaceId: 'ws-1',
            name: 'Test',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      messages: {},
      isStreaming: {},
      sessionProcessing: {},
      sessionBackgroundTaskCount: {},
      streamStartedAt: {},
      lastCompletion: {},
      totalMessageCount: {},
      sessionStatus: {},
      lastActivityAt: {},
      activeSessionIds: {},
      unreadCompletions: {},
    })
  })

  it('session_processing {true,1} sets processing, count, and streaming (hydrates a mid-task subscription)', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: true,
      backgroundTaskCount: 1,
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.sessionProcessing['s1'], true)
    assert.strictEqual(state.sessionBackgroundTaskCount['s1'], 1)
    assert.strictEqual(state.isStreaming['s1'], true)
  })

  it('session_processing {false,0} clears all three slices', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionProcessing: { s1: true },
      sessionBackgroundTaskCount: { s1: 2 },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.sessionProcessing['s1'], false)
    assert.strictEqual(state.sessionBackgroundTaskCount['s1'], 0)
    assert.strictEqual(state.isStreaming['s1'], false)
  })

  it('Covers R7: result while sessionProcessing is true retains isStreaming; the {false,0} edge clears it', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionProcessing: { s1: true },
      sessionBackgroundTaskCount: { s1: 1 },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'result', {})
    assert.strictEqual(
      useChatStore.getState().isStreaming['s1'],
      true,
      'isStreaming retained through the turn result while background tasks run',
    )
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })
    assert.strictEqual(
      useChatStore.getState().isStreaming['s1'],
      false,
      'isStreaming cleared on the final processing edge',
    )
  })

  it('result clears isStreaming when no sessionProcessing entry exists (non-regression)', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ isStreaming: { s1: true } })
    handleSseEvent(set, 'ws-1', 's1', 'result', {})
    assert.strictEqual(useChatStore.getState().isStreaming['s1'], false)
  })

  it('interrupted retains isStreaming while sessionProcessing is true but still appends the notice', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionProcessing: { s1: true },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'interrupted', { messageId: null })
    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming['s1'], true)
    assert.strictEqual(state.messages['s1']?.length, 1, 'interrupt notice appended even while background tasks run')
    assert.strictEqual(state.messages['s1']?.[0]?.role, 'system')
    assert.strictEqual(state.messages['s1']?.[0]?.subType, 'Interrupt')
  })

  it('interrupted clears isStreaming when no sessionProcessing entry exists and appends the notice', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ isStreaming: { s1: true } })
    handleSseEvent(set, 'ws-1', 's1', 'interrupted', { messageId: null })
    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming['s1'], false)
    assert.strictEqual(state.messages['s1']?.length, 1, 'interrupt notice appended')
    assert.strictEqual(state.messages['s1']?.[0]?.role, 'system')
    assert.strictEqual(state.messages['s1']?.[0]?.subType, 'Interrupt')
  })

  it('rate_limit retains isStreaming while sessionProcessing is true but still appends the notice', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionProcessing: { s1: true },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'rate_limit', {})
    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming['s1'], true)
    assert.strictEqual(state.messages['s1'].length, 1, 'rate-limit notice still appended')
  })

  it('rate_limit clears isStreaming when no sessionProcessing entry exists', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ isStreaming: { s1: true } })
    handleSseEvent(set, 'ws-1', 's1', 'rate_limit', {})
    assert.strictEqual(useChatStore.getState().isStreaming['s1'], false)
  })

  it('ignores a session_processing frame with a missing session id', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', '', 'session_processing', {
      processing: true,
      backgroundTaskCount: 1,
    })
    const state = useChatStore.getState()
    assert.deepStrictEqual(state.sessionProcessing, {})
    assert.deepStrictEqual(state.sessionBackgroundTaskCount, {})
    assert.deepStrictEqual(state.isStreaming, {})
  })

  it('routes session_processing through handleWsEvent', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleWsEvent(set, useChatStore.getState, {
      type: 'event',
      eventType: 'sse',
      workspaceId: 'ws-1',
      sessionId: 's1',
      data: { type: 'session_processing', processing: true, backgroundTaskCount: 2 },
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.sessionProcessing['s1'], true)
    assert.strictEqual(state.sessionBackgroundTaskCount['s1'], 2)
    assert.strictEqual(state.isStreaming['s1'], true)
  })

  it('Covers F1: assistant_start → {true,1} → result → {false,0} stays generating through result and clears on the final edge', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: true,
      backgroundTaskCount: 1,
    })
    assert.strictEqual(useChatStore.getState().isStreaming['s1'], true)
    handleSseEvent(set, 'ws-1', 's1', 'result', {})
    assert.strictEqual(
      useChatStore.getState().isStreaming['s1'],
      true,
      'generating persists through the foreground result while a task runs',
    )
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming['s1'], false)
    assert.strictEqual(state.sessionProcessing['s1'], false)
    assert.strictEqual(state.sessionBackgroundTaskCount['s1'], 0)
  })

  it('result on an inactive session while sessionProcessing is true does not set unreadCompletions and keeps streaming', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionProcessing: { s1: true },
      sessionBackgroundTaskCount: { s1: 1 },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'result', {})
    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming['s1'], true, 'streaming retained while background tasks run')
    assert.strictEqual(
      state.unreadCompletions['s1'],
      undefined,
      'unread marker deferred until the final processing edge',
    )
  })

  it('session_processing {false,0} on an inactive session sets unreadCompletions and clears streaming', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionProcessing: { s1: true },
      sessionBackgroundTaskCount: { s1: 1 },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming['s1'], false)
    assert.strictEqual(state.sessionProcessing['s1'], false)
    assert.strictEqual(state.unreadCompletions['s1'], true, 'unread marker lands on the final settle')
  })

  it('session_processing {false,0} on the active session does not set unreadCompletions', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      activeSessionIds: { 'ws-1': 's1' },
      sessionProcessing: { s1: true },
      sessionBackgroundTaskCount: { s1: 1 },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })
    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming['s1'], false)
    assert.strictEqual(state.unreadCompletions['s1'], undefined)
  })

  it('an idle {false,0} verdict on an inactive session does not mark it unread (no prior processing)', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })
    assert.strictEqual(useChatStore.getState().unreadCompletions['s1'], undefined)
  })

  it('no-op guard still skips a repeat identical session_processing verdict', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionProcessing: { s1: false },
      sessionBackgroundTaskCount: { s1: 0 },
      isStreaming: { s1: false },
      unreadCompletions: { s1: true },
    })
    const before = useChatStore.getState()
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })
    const after = useChatStore.getState()
    assert.strictEqual(after.sessionProcessing, before.sessionProcessing, 'processing slice untouched')
    assert.strictEqual(after.sessionBackgroundTaskCount, before.sessionBackgroundTaskCount)
    assert.strictEqual(after.isStreaming, before.isStreaming, 'streaming slice untouched')
    assert.strictEqual(after.unreadCompletions, before.unreadCompletions, 'unread slice untouched')
  })
})

describe('setSessionFastMode', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        'ws-1': [
          {
            id: 's1',
            workspaceId: 'ws-1',
            name: 'Test',
            fastMode: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    })
  })

  it('optimistically updates session fastMode and calls the update endpoint', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    ) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    try {
      await useChatStore.getState().setSessionFastMode('ws-1', 's1', true)
      assert.strictEqual(useChatStore.getState().sessions['ws-1'][0].fastMode, true)
      assert.strictEqual(fetchFn.mock.calls.length, 1)
      assert.strictEqual((fetchFn.mock.calls[0][0] as string), '/api/workspaces/ws-1/sessions/s1')
      assert.strictEqual((fetchFn.mock.calls[0][1] as RequestInit).method, 'PUT')
      assert.ok(
        ((fetchFn.mock.calls[0][1] as RequestInit).body as string).includes('"fastMode":true'),
      )
    } finally {
      fetchFn.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('reverts the optimistic update when the request fails', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: false, status: 500 })) as unknown as Mock &
      typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    try {
      await useChatStore.getState().setSessionFastMode('ws-1', 's1', true)
      assert.strictEqual(useChatStore.getState().sessions['ws-1'][0].fastMode, false)
    } finally {
      fetchFn.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})


describe('in-flight browser tool tracking (F14)', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: {},
      inFlightBrowserTools: {},
      totalMessageCount: {},
      streamStartedAt: {},
      windowCap: 200,
    })
  })

  it('adds on tool_use_start, removes on tool_result', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 't1',
      toolName: 'mcp__comate-browser__open',
    })
    assert.deepStrictEqual(
      [...(useChatStore.getState().inFlightBrowserTools['s1'] ?? [])],
      ['t1'],
    )

    handleSseEvent(set, 'ws-1', 's1', 'tool_result', { toolUseId: 't1', output: 'ok' })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1']?.size ?? 0, 0)
  })

  it('ignores non-browser tools entirely', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 't2',
      toolName: 'Bash',
    })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1'], undefined)
    handleSseEvent(set, 'ws-1', 's1', 'tool_result', { toolUseId: 't2', output: 'ok' })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1'], undefined)
  })

  it('keeps a replayed tool_use_start idempotent and settles a replayed tool_result', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 't1',
      toolName: 'mcp__comate-browser__act',
    })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 't1',
      toolName: 'mcp__comate-browser__act',
    })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1']?.size, 1)
    handleSseEvent(set, 'ws-1', 's1', 'tool_result', { toolUseId: 't1', output: 'ok' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_result', { toolUseId: 't1', output: 'ok' })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1']?.size ?? 0, 0)
  })

  it('deriveInFlightBrowserToolIds pairs results regardless of array order (full-scan rule)', () => {
    // A result BEFORE its use in array order still counts as paired — the
    // wholesale-replacement recompute must match the old selector exactly.
    const ids = deriveInFlightBrowserToolIds([
      {
        id: 'm1',
        role: 'user',
        timestamp: 1,
        parts: [{ type: 'tool_result', toolUseId: 't1', output: '', isError: false }],
      },
      {
        id: 'm2',
        role: 'assistant',
        timestamp: 2,
        parts: [
          { type: 'tool_use', toolUseId: 't1', toolName: 'mcp__comate-browser__open', input: {}, state: 'complete' },
          { type: 'tool_use', toolUseId: 't2', toolName: 'mcp__comate-browser__act', input: {}, state: 'complete' },
        ],
      },
    ])
    assert.deepStrictEqual([...ids], ['t2'])
  })

  it('recomputes when pruning drops an unpaired browser tool_use', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({ windowCap: 50 })
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 't1',
      toolName: 'mcp__comate-browser__open',
    })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1']?.size, 1)
    // Push the window past the cap so the unpaired use is pruned away.
    for (let i = 0; i < 60; i += 1) {
      handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: `mx-${i}` })
    }
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1']?.size ?? 0, 0)
  })

  it('clearMessages drops the session entry', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 't1',
      toolName: 'mcp__comate-browser__open',
    })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1']?.size, 1)
    useChatStore.getState().clearMessages('s1')
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1'], undefined)
  })
})
