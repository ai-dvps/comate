import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { normalizeSdkStatus, sanitizeSubagents, useChatStore } from './chat-store'
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
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ messages: [], tasks: [], subagents: [subagent] }), { status: 200 })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      const state = useChatStore.getState().subagents['s1']
      assert.ok(state)
      assert.strictEqual(state.length, 1)
      assert.strictEqual(state[0].parentToolUseId, 'tool-1')
    } finally {
      globalThis.fetch = originalFetch
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

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ messages: [], tasks: [], subagents: [historical, other] }), { status: 200 })

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
      globalThis.fetch = originalFetch
    }
  })
})
