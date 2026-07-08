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
  type SseSetter,
} from './chat-store'
import { DEFAULT_TIMEOUT, wsClient } from '../lib/websocket-client'
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

      // Switch to workspace 2: s1 should be closed and s2 subscribed.
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
      const unsubscribeForS2 = unsubscribeCalls.find(
        (call) => (call[1] as Record<string, unknown>).sessionId === 's2',
      )
      assert.ok(unsubscribeForS2, 's2 unsubscribed when leaving ws-2')
      assert.strictEqual(unsubscribeCalls.length, 2, 'each prior session unsubscribed once')
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
    handleWsEvent(set, {
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
    handleWsEvent(set, msg)
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
    handleWsEvent(set, msg)
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
    handleWsEvent(set, {
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
    useChatStore.getState().setActiveSession('ws-1', '')
  })

  afterEach(() => {
    requestSpy.mockRestore()
    vi.unstubAllGlobals()
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

