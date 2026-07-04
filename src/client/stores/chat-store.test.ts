import { describe, it, beforeEach, vi } from 'vitest'
import assert from 'node:assert'
import { normalizeSdkStatus, sanitizeSubagents, useChatStore, handleSseEvent, type SseSetter } from './chat-store'
import { DEFAULT_TIMEOUT, wsClient } from '../lib/websocket-client'
import type { SubagentState, TaskItem } from '../types/message'

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

