import { describe, it, beforeEach, afterEach, vi } from 'vitest'
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
  CREATE_SESSION_TIMEOUT_MS,
  deriveInFlightBrowserToolIds,
  scanMessagesForTouchedFiles,
  type SseSetter,
  mergeSessionStatusEntry,
  newChatDraftSessionId,
  promptImageDraftKey,
  type ChatSession,
} from './chat-store'
import { compareSessionActivity } from '../lib/session-sort'
import { sortWorkspacesByActivity } from '../lib/workspace-sort'
import { useWorkspaceStore } from './workspace-store'
import {
  DEFAULT_TIMEOUT,
  WebSocketRequestTimeoutError,
  wsClient,
} from '../lib/websocket-client'
import { useToastStore } from './toast-store'
import type {
  ChatMessage,
  MessagePart,
  SubagentPart,
  SubagentState,
  TaskItem,
  WorkflowState,
  WorkflowStatus,
} from '../types/message'
import type { WsEventMessage } from '@server/websocket/types'
import { toUserTurnImage } from '../lib/image-input'
import zhCommon from '../i18n/zh-CN/common.json'

function makePromptImage(id: string) {
  return {
    id,
    name: `${id}.png`,
    mediaType: 'image/png' as const,
    data: 'AA==',
    width: 1,
    height: 1,
    blob: new Blob(['image']),
    previewUrl: `blob:${id}`,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useChatStore.setState({ historyLoadState: {} })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('session status polling', () => {
  it('preserves and clears the pending interaction discriminator', () => {
    assert.deepStrictEqual(
      mergeSessionStatusEntry(undefined, {
        pendingCount: 1,
        pendingKind: 'question',
        isProcessing: true,
      }),
      { pendingCount: 1, pendingKind: 'question', isProcessing: true },
    )
    assert.strictEqual(
      mergeSessionStatusEntry(
        { pendingCount: 1, pendingKind: 'question', isProcessing: true },
        { pendingCount: 0, isProcessing: false },
      ),
      undefined,
    )
  })
})

describe('runtime image drafts', () => {
  it('keys image drafts by workspace and session identity', () => {
    useChatStore.setState({ imageDrafts: {} })
    const first = [{
      id: 'one',
      name: 'one.png',
      mediaType: 'image/png' as const,
      data: 'AA==',
      width: 1,
      height: 1,
      blob: new Blob(),
      previewUrl: 'blob:one',
    }]
    const second = [{ ...first[0], id: 'two', previewUrl: 'blob:two' }]

    useChatStore.getState().setImageDrafts('workspace-a', 'same-session', first)
    useChatStore.getState().setImageDrafts('workspace-b', 'same-session', second)

    expect(useChatStore.getState().imageDrafts[promptImageDraftKey('workspace-a', 'same-session')]).toBe(first)
    expect(useChatStore.getState().imageDrafts[promptImageDraftKey('workspace-b', 'same-session')]).toBe(second)
  })

  it('removes an empty image draft without touching another session', () => {
    const retained = [{
      id: 'retained',
      name: 'retained.png',
      mediaType: 'image/png' as const,
      data: 'AA==',
      width: 1,
      height: 1,
      blob: new Blob(),
      previewUrl: 'blob:retained',
    }]
    useChatStore.setState({
      imageDrafts: {
        [promptImageDraftKey('workspace-a', 'one')]: retained,
        [promptImageDraftKey('workspace-a', 'two')]: retained,
      },
    })

    useChatStore.getState().setImageDrafts('workspace-a', 'one', [])

    expect(useChatStore.getState().imageDrafts[promptImageDraftKey('workspace-a', 'one')]).toBeUndefined()
    expect(useChatStore.getState().imageDrafts[promptImageDraftKey('workspace-a', 'two')]).toBe(retained)
  })
})

describe('multimodal pending turn ownership', () => {
  const session = {
    id: 's1',
    workspaceId: 'ws-1',
    name: 'Test',
    source: 'gui' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  beforeEach(() => {
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
    useChatStore.setState({
      sessions: { 'ws-1': [session] },
      messages: {},
      drafts: {},
      imageDrafts: {},
      approvalQueue: {},
      draftQueue: {},
      pendingSend: {},
      pendingTurns: {},
      serverNonce: { s1: 'nonce-1' },
      isStreaming: {},
      sessionActivity: {},
    })
  })

  it('freezes a mixed turn for optimistic UI and sends ordered wire images', async () => {
    const images = [makePromptImage('one'), makePromptImage('two')]
    const request = deferred<unknown>()
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      type === 'sendMessage' ? request.promise : Promise.resolve({}),
    )
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    useChatStore.setState({ serverNonce: { s1: 'nonce-1' } })
    requestSpy.mockClear()
    useChatStore.getState().setDraft('s1', '  fix both  ')
    useChatStore.getState().setImageDrafts('ws-1', 's1', images)

    useChatStore.getState().sendMessage('ws-1', 's1', {
      text: '  fix both  ',
      images,
    })

    const state = useChatStore.getState()
    const payload = requestSpy.mock.calls.find((call) => call[0] === 'sendMessage')?.[1] as Record<string, unknown>
    expect(payload).toMatchObject({
      workspaceId: 'ws-1',
      sessionId: 's1',
      content: 'fix both',
      images: images.map(toUserTurnImage),
    })
    expect(payload.clientTurnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(state.pendingTurns.s1?.clientTurnId).toBe(payload.clientTurnId)
    expect(state.drafts.s1).toBeUndefined()
    expect(state.imageDrafts[promptImageDraftKey('ws-1', 's1')]).toBeUndefined()
    expect(state.messages.s1?.[0]).toMatchObject({
      id: payload.clientTurnId,
      role: 'user',
      parts: [
        { type: 'text', text: 'fix both' },
        { type: 'image', name: 'one.png', source: { type: 'base64', data: 'AA==' } },
        { type: 'image', name: 'two.png', source: { type: 'base64', data: 'AA==' } },
      ],
    })
    expect(historySpy).toHaveBeenCalledWith('ws-1', 's1', 'fix both')

    request.resolve({ sent: true })
    await request.promise
    historySpy.mockRestore()
    requestSpy.mockRestore()
  })

  it('restores a rejected snapshot without overwriting a newer draft', async () => {
    const submitted = makePromptImage('submitted')
    const newer = makePromptImage('newer')
    const request = deferred<unknown>()
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      type === 'sendMessage' ? request.promise : Promise.resolve({}),
    )
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    useChatStore.setState({ serverNonce: { s1: 'nonce-1' } })
    requestSpy.mockClear()
    useChatStore.getState().setDraft('s1', 'submitted text')
    useChatStore.getState().setImageDrafts('ws-1', 's1', [submitted])

    const clientTurnId = useChatStore.getState().sendMessage('ws-1', 's1', {
      text: 'submitted text',
      images: [submitted],
    })
    useChatStore.getState().setDraft('s1', 'newer text')
    useChatStore.getState().setImageDrafts('ws-1', 's1', [newer])
    request.reject(new Error('transport failed'))
    await expect(request.promise).rejects.toThrow('transport failed')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = useChatStore.getState()
    expect(state.drafts.s1).toBe('submitted text\nnewer text')
    expect(state.imageDrafts[promptImageDraftKey('ws-1', 's1')]).toEqual([submitted, newer])
    expect(state.pendingTurns.s1).toBeUndefined()
    expect(state.messages.s1?.some((message) => message.id === clientTurnId)).toBe(false)
    historySpy.mockRestore()
    requestSpy.mockRestore()
  })

  it('retries an ambiguous timeout with the same identity without restoring or duplicating the draft', async () => {
    const image = makePromptImage('slow')
    const retry = deferred<unknown>()
    let sendAttempt = 0
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) => {
      if (type !== 'sendMessage') return Promise.resolve({})
      sendAttempt += 1
      return sendAttempt === 1
        ? Promise.reject(new WebSocketRequestTimeoutError('sendMessage'))
        : retry.promise
    })
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    useChatStore.setState({ serverNonce: { s1: 'nonce-1' } })
    requestSpy.mockClear()

    const clientTurnId = useChatStore.getState().sendMessage('ws-1', 's1', {
      text: 'slow admission',
      images: [image],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const sends = requestSpy.mock.calls.filter(([type]) => type === 'sendMessage')
    expect(sends).toHaveLength(2)
    expect(sends[0]?.[1]).toMatchObject({ clientTurnId })
    expect(sends[1]?.[1]).toMatchObject({ clientTurnId })
    expect(useChatStore.getState().pendingTurns.s1?.clientTurnId).toBe(clientTurnId)
    expect(useChatStore.getState().drafts.s1).toBeUndefined()
    expect(useChatStore.getState().imageDrafts[promptImageDraftKey('ws-1', 's1')]).toBeUndefined()
    expect(useChatStore.getState().messages.s1?.filter((message) => message.id === clientTurnId)).toHaveLength(1)

    retry.resolve({ sent: true, clientTurnId })
    await retry.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useChatStore.getState().pendingTurns.s1).toBeUndefined()
    historySpy.mockRestore()
    requestSpy.mockRestore()
  })

  it('localizes an admission acknowledgement identity mismatch', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type, payload) =>
      type === 'sendMessage'
        ? Promise.resolve({ sent: true, clientTurnId: `${String(payload.clientTurnId)}-wrong` })
        : Promise.resolve({}),
    )
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    useChatStore.setState({ serverNonce: { s1: 'nonce-1' } })
    requestSpy.mockClear()

    useChatStore.getState().sendMessage('ws-1', 's1', 'identity mismatch')
    await vi.waitFor(() => {
      const systemText = useChatStore.getState().messages.s1
        ?.flatMap((message) => message.parts)
        .find((part) => part.type === 'text' && part.text.includes('server acknowledgement'))
      expect(systemText).toMatchObject({
        type: 'text',
        text: expect.stringContaining('The server acknowledgement did not match the submitted message'),
      })
    })
    expect(zhCommon.admissionAcknowledgementMismatch).toBe('服务器确认与已提交的消息不匹配')

    historySpy.mockRestore()
    requestSpy.mockRestore()
  })

  it('accepts only the matching snapshot and preserves a newer draft', async () => {
    const submitted = makePromptImage('submitted')
    const newer = makePromptImage('newer')
    const request = deferred<unknown>()
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      type === 'sendMessage' ? request.promise : Promise.resolve({}),
    )
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    useChatStore.setState({ serverNonce: { s1: 'nonce-1' }, promptHistory: {} })
    requestSpy.mockClear()
    useChatStore.getState().setImageDrafts('ws-1', 's1', [submitted])

    useChatStore.getState().sendMessage('ws-1', 's1', { text: '', images: [submitted] })
    useChatStore.getState().setDraft('s1', 'newer text')
    useChatStore.getState().setImageDrafts('ws-1', 's1', [newer])
    request.resolve({ sent: true })
    await request.promise
    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = useChatStore.getState()
    expect(state.drafts.s1).toBe('newer text')
    expect(state.imageDrafts[promptImageDraftKey('ws-1', 's1')]).toEqual([newer])
    expect(state.pendingTurns.s1).toBeUndefined()
    expect(revokeSpy).toHaveBeenCalledWith('blob:submitted')
    expect(revokeSpy).not.toHaveBeenCalledWith('blob:newer')
    expect(historySpy).toHaveBeenCalledWith('ws-1', 's1', '')
    expect(state.promptHistory['ws-1']).toBeUndefined()
    revokeSpy.mockRestore()
    historySpy.mockRestore()
    requestSpy.mockRestore()
  })

  it('retains ordered images while waiting for subscription acknowledgement', async () => {
    const images = [makePromptImage('one'), makePromptImage('two')]
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ sent: true })
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    useChatStore.setState({ serverNonce: {} })

    const clientTurnId = useChatStore.getState().sendMessage('ws-1', 's1', {
      text: '',
      images,
    })
    expect(useChatStore.getState().pendingSend.s1?.clientTurnId).toBe(clientTurnId)
    expect(useChatStore.getState().pendingSend.s1?.images).toEqual(images)
    expect(requestSpy.mock.calls.some((call) => call[0] === 'sendMessage')).toBe(false)

    handleSseEvent(
      useChatStore.setState as unknown as SseSetter,
      'ws-1',
      's1',
      'subscription_ack',
      { serverNonce: 'nonce-1' },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    const payload = requestSpy.mock.calls.find((call) => call[0] === 'sendMessage')?.[1] as Record<string, unknown>
    expect(payload.clientTurnId).toBe(clientTurnId)
    expect(payload.images).toEqual(images.map(toUserTurnImage))
    historySpy.mockRestore()
    requestSpy.mockRestore()
  })

  it('retains the complete turn while an approval is pending', async () => {
    const image = makePromptImage('approval')
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({ sent: true })
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    useChatStore.getState().setActiveSession('ws-1', 's1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    useChatStore.setState({
      serverNonce: { s1: 'nonce-1' },
      approvalQueue: {
        s1: [{
          requestId: 'approval-1',
          toolName: 'Bash',
          toolUseId: 'tool-1',
          input: {},
          inputSummary: 'Run command',
        }],
      },
    })
    requestSpy.mockClear()

    const clientTurnId = useChatStore.getState().sendMessage('ws-1', 's1', {
      text: 'after approval',
      images: [image],
    })
    expect(useChatStore.getState().draftQueue.s1?.clientTurnId).toBe(clientTurnId)
    expect(useChatStore.getState().draftQueue.s1?.images).toEqual([image])
    expect(requestSpy).not.toHaveBeenCalled()

    handleSseEvent(
      useChatStore.setState as unknown as SseSetter,
      'ws-1',
      's1',
      'approval_resolved',
      { requestId: 'approval-1' },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    const payload = requestSpy.mock.calls.find((call) => call[0] === 'sendMessage')?.[1] as Record<string, unknown>
    expect(payload.clientTurnId).toBe(clientTurnId)
    expect(payload.images).toEqual([expect.objectContaining({ id: 'approval' })])
    historySpy.mockRestore()
    requestSpy.mockRestore()
  })

  it('transfers a workspace New Chat draft to the created session before send', () => {
    const image = makePromptImage('new-chat')
    const source = newChatDraftSessionId('ws-1')
    useChatStore.getState().setDraft(source, 'draft text')
    useChatStore.getState().setImageDrafts('ws-1', source, [image])

    useChatStore.getState().transferDraft('ws-1', source, 'created', {
      text: 'draft text',
      images: [image],
    })

    const state = useChatStore.getState()
    expect(state.drafts[source]).toBeUndefined()
    expect(state.imageDrafts[promptImageDraftKey('ws-1', source)]).toBeUndefined()
    expect(state.drafts.created).toBe('draft text')
    expect(state.imageDrafts[promptImageDraftKey('ws-1', 'created')]).toEqual([image])
  })
})

describe('session title updates', () => {
  it('applies an OpenCode title only while the user has not set a custom title', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessions: {
        'ws-1': [
          { id: 'auto', workspaceId: 'ws-1', name: 'Fallback', createdAt: '', updatedAt: '' },
          { id: 'manual', workspaceId: 'ws-1', name: 'Mine', customTitle: 'Mine', createdAt: '', updatedAt: '' },
        ],
      },
    })

    handleSseEvent(set, 'ws-1', 'auto', 'session_title', { title: 'Generated title' })
    handleSseEvent(set, 'ws-1', 'manual', 'session_title', { title: 'Must not win' })

    const sessions = useChatStore.getState().sessions['ws-1']
    assert.strictEqual(sessions.find((session) => session.id === 'auto')?.name, 'Generated title')
    assert.strictEqual(sessions.find((session) => session.id === 'manual')?.name, 'Mine')
  })
})

describe('new chat session creation', () => {
  it('sends the initial prompt for server-side fallback title derivation and returns the session', async () => {
    const session = { id: 's-new', workspaceId: 'ws-1', name: 'Derived', createdAt: '', updatedAt: '' }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => session,
      init,
    }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      const options = {
        initialPrompt: '/ce-debug Fix redirects',
        approvalMode: 'auto' as const,
        providerId: 'provider-2',
        backend: 'opencode',
        fastMode: true,
      }
      const created = await useChatStore.getState().createSession('ws-1', options)

      assert.strictEqual(created.ok && created.session.id, 's-new')
      assert.deepStrictEqual(JSON.parse(fetchMock.mock.calls[0][1]?.body as string), {
        prompt: '/ce-debug Fix redirects',
        approvalMode: 'auto',
        providerId: 'provider-2',
        backend: 'opencode',
        fastMode: true,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns a structured HTTP failure without retrying the POST', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await useChatStore.getState().createSession('ws-1', { initialPrompt: 'Try once' })

    assert.deepStrictEqual(result, {
      ok: false,
      reason: 'http',
      error: 'Failed to create session',
    })
    assert.strictEqual(fetchMock.mock.calls.length, 1)
  })

  it('bounds session creation and reports a timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })))

    const pending = useChatStore.getState().createSession('ws-1', { initialPrompt: 'May hang' })
    await vi.advanceTimersByTimeAsync(CREATE_SESSION_TIMEOUT_MS)

    assert.deepStrictEqual(await pending, {
      ok: false,
      reason: 'timeout',
      error: 'Creating the session timed out. Try again.',
    })
  })
})

describe('complete history loading', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: {},
      tasks: {},
      subagents: {},
      workflows: {},
      isLoadingMessages: {},
      totalMessageCount: {},
      historyLoadState: {},
    })
  })

  it('merges a live message that arrives while complete history is loading', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    const response = new Promise((resolve) => {
      resolveRequest = resolve
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockReturnValue(response as never)

    try {
      const loading = useChatStore.getState().loadMessages('ws-1', 's1')
      useChatStore.setState({
        messages: {
          s1: [{ id: 'live-1', role: 'assistant', parts: [{ type: 'text', text: 'live' }], timestamp: 3 }],
        },
      })
      resolveRequest?.({
        messages: [
          { id: 'history-1', role: 'user', parts: [{ type: 'text', text: 'old' }], timestamp: 1 },
          { id: 'history-2', role: 'assistant', parts: [{ type: 'text', text: 'reply' }], timestamp: 2 },
        ],
        tasks: [],
        subagents: [],
        workflows: [],
      })
      await loading

      assert.deepStrictEqual(
        useChatStore.getState().messages.s1.map((message) => message.id),
        ['history-1', 'history-2', 'live-1'],
      )
      assert.strictEqual(useChatStore.getState().historyLoadState.s1, 'loaded')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('preserves history images and replaces a replayed optimistic turn before admission ack', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({
      messages: [{
        id: 'client-turn-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'inspect this' },
          {
            type: 'image',
            mediaType: 'image/png',
            name: 'bug.png',
            width: 640,
            height: 480,
            source: { type: 'base64', data: 'iVBORw0KGgo=' },
          },
        ],
        timestamp: 1,
      }],
      tasks: [],
      subagents: [],
      workflows: [],
    })

    useChatStore.setState({
      messages: {
        s1: [{
          id: 'client-turn-1',
          role: 'user',
          parts: [{ type: 'text', text: 'inspect this' }],
          timestamp: 2,
        }],
      },
      pendingTurns: {
        s1: {
          clientTurnId: 'client-turn-1',
          workspaceId: 'ws-1',
          sessionId: 's1',
          text: 'inspect this',
          images: [],
          wireImages: [],
        },
      },
    })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')

      const messages = useChatStore.getState().messages.s1
      assert.strictEqual(messages.length, 1)
      assert.strictEqual(messages[0].id, 'client-turn-1')
      assert.strictEqual(useChatStore.getState().pendingTurns.s1?.clientTurnId, 'client-turn-1')
      assert.deepStrictEqual(messages[0].parts[1], {
        type: 'image',
        mediaType: 'image/png',
        name: 'bug.png',
        width: 640,
        height: 480,
        source: { type: 'base64', data: 'iVBORw0KGgo=' },
      })
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('coalesces concurrent complete-history requests', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    const response = new Promise((resolve) => {
      resolveRequest = resolve
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockReturnValue(response as never)

    try {
      const first = useChatStore.getState().loadMessages('ws-1', 's1')
      const second = useChatStore.getState().loadMessages('ws-1', 's1')
      assert.strictEqual(requestSpy.mock.calls.length, 1)
      assert.deepStrictEqual(requestSpy.mock.calls[0][1], {
        workspaceId: 'ws-1',
        sessionId: 's1',
      })

      resolveRequest?.({ messages: [], tasks: [], subagents: [], workflows: [] })
      await Promise.all([first, second])
      assert.strictEqual(useChatStore.getState().historyLoadState.s1, 'loaded')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('clears readiness after failure so a later load can retry', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request')
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce({ messages: [], tasks: [], subagents: [], workflows: [] })

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')
      assert.strictEqual(useChatStore.getState().historyLoadState.s1, undefined)
      assert.strictEqual(useChatStore.getState().isLoadingMessages.s1, false)

      await useChatStore.getState().loadMessages('ws-1', 's1')
      assert.strictEqual(requestSpy.mock.calls.length, 2)
      assert.strictEqual(useChatStore.getState().historyLoadState.s1, 'loaded')
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('ignores a complete-history response after the session cache is cleared', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    const response = new Promise((resolve) => {
      resolveRequest = resolve
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockReturnValue(response as never)

    try {
      const loading = useChatStore.getState().loadMessages('ws-1', 's1')
      useChatStore.getState().clearMessages('s1')
      resolveRequest?.({
        messages: [{ id: 'stale-1', role: 'user', parts: [{ type: 'text', text: 'stale' }], timestamp: 1 }],
        tasks: [],
        subagents: [],
        workflows: [],
      })
      await loading

      assert.strictEqual(useChatStore.getState().messages.s1, undefined)
      assert.strictEqual(useChatStore.getState().historyLoadState.s1, undefined)
    } finally {
      requestSpy.mockRestore()
    }
  })
})

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

  it('maps enriched CLI 2.1.237 context_usage fields', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'context_usage', {
      totalTokens: 120000,
      maxTokens: 200000,
      percentage: 60,
      categories: [
        { name: 'Messages', tokens: 80000 },
        { name: 'MCP tools (deferred)', tokens: 5000, isDeferred: true },
      ],
      model: 'claude-opus-4-8',
      rawMaxTokens: 200000,
      autoCompactThreshold: 156000,
      overLimit: { tokensOver: 12000, kind: 'compaction_window' },
      mcpTools: [{ name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 3000 }],
      memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 2000 }],
      agents: [{ agentType: 'code-reviewer', source: 'projectSettings', tokens: 1500 }],
      skills: [{ name: 'wecom', source: 'plugin', tokens: 900 }],
    })
    const usage = useChatStore.getState().contextUsage['s1']
    assert.ok(usage)
    assert.strictEqual(usage.model, 'claude-opus-4-8')
    assert.strictEqual(usage.autoCompactThreshold, 156000)
    assert.deepStrictEqual(usage.overLimit, { tokensOver: 12000, kind: 'compaction_window' })
    assert.strictEqual(usage.categories[1].isDeferred, true)
    assert.strictEqual(usage.mcpTools?.[0].serverName, 'linear')
    assert.strictEqual(usage.memoryFiles?.[0].type, 'Project')
    assert.strictEqual(usage.agents?.[0].agentType, 'code-reviewer')
    assert.strictEqual(usage.skills?.[0].name, 'wecom')
  })

  it('keeps enrichment fields absent when an older CLI sends the base payload', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'context_usage', {
      totalTokens: 100,
      maxTokens: 200000,
      percentage: 5,
      categories: [],
    })
    const usage = useChatStore.getState().contextUsage['s1']
    assert.ok(usage)
    assert.strictEqual(usage.model, undefined)
    assert.strictEqual(usage.overLimit, undefined)
    assert.strictEqual(usage.mcpTools, undefined)
    assert.strictEqual(usage.skills, undefined)
  })
})

describe('handleSseEvent system_init', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      messages: {},
      subagents: {},
      workflows: {},
      tasks: {},
      contextUsage: {},
      sessionRuntimeInfo: {},
    })
  })

  it('stores effort, outputStyle, and capabilities from the init frame', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'system_init', {
      model: 'claude-opus-4-8',
      tools: ['Bash'],
      sessionId: 's1',
      effort: 'high',
      outputStyle: 'concise',
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
    })
    const info = useChatStore.getState().sessionRuntimeInfo['s1']
    assert.ok(info)
    assert.strictEqual(info.effort, 'high')
    assert.strictEqual(info.outputStyle, 'concise')
    assert.deepStrictEqual(info.capabilities, ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'])
  })

  it('stores null effort and omits absent optional fields', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'system_init', {
      model: 'claude-sonnet-5',
      tools: [],
      sessionId: 's1',
      effort: null,
    })
    const info = useChatStore.getState().sessionRuntimeInfo['s1']
    assert.ok(info)
    assert.strictEqual(info.effort, null)
    assert.strictEqual(info.outputStyle, undefined)
    assert.strictEqual(info.capabilities, undefined)
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
      pendingTurns: {},
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

  it('claims foreground activity immediately when sending during background work', () => {
    const backgroundTasks = [{ id: 'bg-1', type: 'agent', description: 'Research' }]
    useChatStore.setState({
      sessions: { 'ws-1': [makeSession('gui')] },
      serverNonce: { s1: 'nonce-1' },
      isStreaming: { s1: true },
      sessionActivity: {
        s1: { phase: 'background', active: true, backgroundTasks },
      },
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})

    try {
      useChatStore.getState().sendMessage('ws-1', 's1', 'follow up')

      assert.deepStrictEqual(useChatStore.getState().sessionActivity.s1, {
        phase: 'foreground',
        active: true,
        backgroundTasks,
      })
      assert.strictEqual(useChatStore.getState().isStreaming.s1, true)
    } finally {
      historySpy.mockRestore()
      requestSpy.mockRestore()
    }
  })

  it('stops one background task through the task-scoped endpoint', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true })) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    try {
      await useChatStore.getState().stopBackgroundTask('ws-1', 's1', 'task-2')

      assert.strictEqual(fetchFn.mock.calls.length, 1)
      assert.strictEqual(
        fetchFn.mock.calls[0][0],
        '/api/workspaces/ws-1/sessions/s1/tasks/task-2/stop',
      )
      assert.deepStrictEqual(fetchFn.mock.calls[0][1], { method: 'POST' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('adds a system message when a background task cannot be stopped', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ error: 'control request failed' }),
    })) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    try {
      await useChatStore.getState().stopBackgroundTask('ws-1', 's1', 'task-2')

      const message = useChatStore.getState().messages.s1?.at(-1)
      assert.strictEqual(message?.role, 'system')
      assert.deepStrictEqual(message?.parts, [{
        type: 'text',
        text: 'Task stop error: control request failed',
      }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('marks complete history ready when a draft sends its first message', () => {
    useChatStore.setState({
      sessions: { 'ws-1': [{ ...makeSession('gui'), isDraft: true }] },
      serverNonce: { s1: 'nonce-1' },
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      useChatStore.getState().sendMessage('ws-1', 's1', 'first prompt')

      const state = useChatStore.getState()
      assert.strictEqual(state.sessions['ws-1'][0].isDraft, false)
      assert.strictEqual(state.historyLoadState.s1, 'loaded')
      assert.strictEqual(state.messages.s1?.length, 1)
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
      pendingTurns: {},
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
      assert.deepStrictEqual(
        useChatStore.getState().pendingSend['s1'],
        useChatStore.getState().pendingTurns['s1'],
      )
      assert.strictEqual(useChatStore.getState().pendingSend['s1']?.text.trim(), 'hello')
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
      pendingTurns: {},
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
      assert.deepStrictEqual(
        useChatStore.getState().pendingSend['s1'],
        useChatStore.getState().pendingTurns['s1'],
      )
      assert.strictEqual(useChatStore.getState().pendingSend['s1']?.text.trim(), 'second')
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
      useChatStore.setState({
        messages: {
          s1: [{ id: 'history-1', role: 'user', parts: [{ type: 'text', text: 'old' }], timestamp: 1 }],
        },
        historyLoadState: { s1: 'loaded' },
        totalMessageCount: { s1: 1 },
      })
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
      assert.strictEqual(state.messages.s1, undefined)
      assert.strictEqual(state.historyLoadState.s1, undefined)
      assert.strictEqual(state.totalMessageCount.s1, undefined)

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

  it('sends an explicit null when switching to the native Codex account', async () => {
    useChatStore.setState({
      sessions: { 'ws-1': [{ ...makeGuiSession(), backend: 'codex', providerId: 'p2' }] },
    })

    await useChatStore.getState().setSessionProvider('ws-1', 's1', null)

    const fetchMock = vi.mocked(fetch)
    assert.deepStrictEqual(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)), {
      providerId: null,
    })
    assert.strictEqual(useChatStore.getState().sessions['ws-1'][0].providerId, undefined)
  })

  it('persists per-session Codex model, effort, and speed together', async () => {
    await useChatStore.getState().setSessionCodexSettings('ws-1', 's1', {
      codexModel: 'gpt-5.6-codex',
      codexEffort: 'high',
      codexSpeed: 'fast',
    })

    const session = useChatStore.getState().sessions['ws-1'][0]
    assert.strictEqual(session.codexModel, 'gpt-5.6-codex')
    assert.strictEqual(session.codexEffort, 'high')
    assert.strictEqual(session.codexSpeed, 'fast')
    const fetchMock = vi.mocked(fetch)
    assert.deepStrictEqual(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)), {
      codexModel: 'gpt-5.6-codex',
      codexEffort: 'high',
      codexSpeed: 'fast',
    })
  })

  it('does not let an older failed Codex settings request roll back a newer choice', async () => {
    let rejectFirstRequest: ((reason?: unknown) => void) | undefined
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirstRequest = reject
      }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const firstRequest = useChatStore.getState().setSessionCodexSettings('ws-1', 's1', {
      codexModel: 'gpt-5.6-codex',
      codexEffort: 'high',
      codexSpeed: 'fast',
    })
    const firstRejection = expect(firstRequest).rejects.toThrow('stale request failed')
    await useChatStore.getState().setSessionCodexSettings('ws-1', 's1', {
      codexModel: 'gpt-5.7-codex',
      codexEffort: 'medium',
      codexSpeed: 'standard',
    })
    rejectFirstRequest?.(new Error('stale request failed'))
    await firstRejection

    const session = useChatStore.getState().sessions['ws-1'][0]
    assert.strictEqual(session.codexModel, 'gpt-5.7-codex')
    assert.strictEqual(session.codexEffort, 'medium')
    assert.strictEqual(session.codexSpeed, 'standard')
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

describe('touched-files scanning', () => {
  function makeTouchMessage(opts: {
    timestamp: number
    toolUseId: string
    toolName: string
    input: unknown
    isError?: boolean
    toolUseResult?: unknown
    omitResult?: boolean
  }): ChatMessage {
    const parts: MessagePart[] = [
      {
        type: 'tool_use',
        toolUseId: opts.toolUseId,
        toolName: opts.toolName,
        input: opts.input,
        state: 'complete',
      },
    ]
    if (!opts.omitResult) {
      parts.push({
        type: 'tool_result',
        toolUseId: opts.toolUseId,
        output: opts.isError ? 'tool failed' : 'ok',
        isError: opts.isError === true,
        ...(opts.toolUseResult !== undefined && { toolUseResult: opts.toolUseResult }),
      })
    }
    return {
      id: `m-${opts.toolUseId}`,
      role: 'assistant',
      parts,
      timestamp: opts.timestamp,
    }
  }

  function makeSubagentWithTouch(opts: {
    parentToolUseId: string
    startTime: number
    endTime?: number
    toolUseId: string
    toolName: string
    input: unknown
    isError?: boolean
    omitResult?: boolean
  }): SubagentState {
    const parts: SubagentPart[] = [
      { type: 'tool_use', toolUseId: opts.toolUseId, toolName: opts.toolName, input: opts.input },
    ]
    if (!opts.omitResult) {
      parts.push({
        type: 'tool_result',
        toolUseId: opts.toolUseId,
        output: opts.isError ? 'tool failed' : 'ok',
        isError: opts.isError === true,
      })
    }
    return {
      parentToolUseId: opts.parentToolUseId,
      description: 'agent',
      state: opts.endTime !== undefined ? 'completed' : 'running',
      startTime: opts.startTime,
      ...(opts.endTime !== undefined && { endTime: opts.endTime }),
      toolCount: 1,
      progressHint: '',
      messages: [{ id: 'sm-1', role: 'assistant', parts }],
    }
  }

  it('dedupes three Edit results for one path into a single modified entry (AE1)', () => {
    const messages = [10, 20, 30].map((timestamp, i) =>
      makeTouchMessage({
        timestamp,
        toolUseId: `edit-${i}`,
        toolName: 'Edit',
        input: { file_path: '/ws/src/a.ts', old_string: `${i}`, new_string: `${i + 1}` },
      }),
    )

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/src/a.ts', status: 'modified', lastTouchedAt: 30 },
    ])
  })

  it('marks a Write with create metadata as created and keeps created sticky after a later Edit', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'w1',
        toolName: 'Write',
        input: { file_path: '/ws/new.ts', content: 'x' },
        toolUseResult: { type: 'create', filePath: '/ws/new.ts', content: 'x' },
      }),
      makeTouchMessage({
        timestamp: 20,
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/ws/new.ts', old_string: 'x', new_string: 'y' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/new.ts', status: 'created', lastTouchedAt: 20 },
    ])
  })

  it('treats a first-seen Write with update metadata as modified', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'w1',
        toolName: 'Write',
        input: { file_path: '/ws/rewrite.ts', content: 'x' },
        toolUseResult: { type: 'update', filePath: '/ws/rewrite.ts', content: 'x' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/rewrite.ts', status: 'modified', lastTouchedAt: 10 },
    ])
  })

  it('reads Edit creations from a null originalFile marker in the result metadata', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/ws/created-by-edit.ts', old_string: '', new_string: 'x' },
        toolUseResult: { filePath: '/ws/created-by-edit.ts', originalFile: null, structuredPatch: [] },
      }),
      makeTouchMessage({
        timestamp: 20,
        toolUseId: 'e2',
        toolName: 'Edit',
        input: { file_path: '/ws/edited.ts', old_string: 'a', new_string: 'b' },
        toolUseResult: { filePath: '/ws/edited.ts', originalFile: 'a', structuredPatch: [] },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/edited.ts', status: 'modified', lastTouchedAt: 20 },
      { path: '/ws/created-by-edit.ts', status: 'created', lastTouchedAt: 10 },
    ])
  })

  it('falls back to the heuristic without metadata: first-seen Write is created, first-seen Edit is modified', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'w1',
        toolName: 'Write',
        input: { file_path: '/ws/fresh.ts', content: 'x' },
      }),
      makeTouchMessage({
        timestamp: 20,
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/ws/existing.ts', old_string: 'a', new_string: 'b' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/existing.ts', status: 'modified', lastTouchedAt: 20 },
      { path: '/ws/fresh.ts', status: 'created', lastTouchedAt: 10 },
    ])
  })

  it('produces no entry when the tool result carries an error', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/ws/a.ts', old_string: 'missing', new_string: 'b' },
        isError: true,
      }),
    ]

    assert.deepStrictEqual(scanMessagesForTouchedFiles(messages, []), [])
  })

  it('produces no entry when the tool use has no result (approval never decided)', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'w1',
        toolName: 'Write',
        input: { file_path: '/ws/pending.ts', content: 'x' },
        omitResult: true,
      }),
    ]

    assert.deepStrictEqual(scanMessagesForTouchedFiles(messages, []), [])
  })

  it('collects NotebookEdit touches via notebook_path', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'nb1',
        toolName: 'NotebookEdit',
        input: { notebook_path: '/ws/nb.ipynb', cell_id: 'c1', new_source: 'print(1)' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/nb.ipynb', status: 'modified', lastTouchedAt: 10 },
    ])
  })

  it('collects MultiEdit touches via file_path', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'me1',
        toolName: 'MultiEdit',
        input: { file_path: '/ws/multi.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/multi.ts', status: 'modified', lastTouchedAt: 10 },
    ])
  })

  it('returns an empty list for messages containing only Bash tool uses (AE3)', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'b1',
        toolName: 'Bash',
        input: { command: 'echo hi > /ws/sneaky.ts' },
      }),
      makeTouchMessage({
        timestamp: 20,
        toolUseId: 'b2',
        toolName: 'Bash',
        input: { command: 'rm /ws/gone.ts' },
      }),
    ]

    assert.deepStrictEqual(scanMessagesForTouchedFiles(messages, []), [])
  })

  it('collects subagent touches the same as main-channel parts', () => {
    const subagents = [
      makeSubagentWithTouch({
        parentToolUseId: 'sa-1',
        startTime: 50,
        endTime: 200,
        toolUseId: 'sa-1-e1',
        toolName: 'Edit',
        input: { file_path: '/ws/agent.ts', old_string: 'a', new_string: 'b' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles([], subagents)

    assert.deepStrictEqual(entries, [
      { path: '/ws/agent.ts', status: 'modified', lastTouchedAt: 200 },
    ])
  })

  it('orders a history-rebuilt subagent touch by the parent end-or-start time rather than sinking to the bottom', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 150,
        toolUseId: 'm1',
        toolName: 'Edit',
        input: { file_path: '/ws/main.ts', old_string: 'a', new_string: 'b' },
      }),
    ]
    const subagents = [
      makeSubagentWithTouch({
        parentToolUseId: 'sa-1',
        startTime: 50,
        endTime: 200,
        toolUseId: 'sa-1-e1',
        toolName: 'Edit',
        input: { file_path: '/ws/agent.ts', old_string: 'a', new_string: 'b' },
      }),
      makeSubagentWithTouch({
        parentToolUseId: 'sa-2',
        startTime: 120,
        toolUseId: 'sa-2-e1',
        toolName: 'Edit',
        input: { file_path: '/ws/running-agent.ts', old_string: 'a', new_string: 'b' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, subagents)

    assert.deepStrictEqual(entries, [
      { path: '/ws/agent.ts', status: 'modified', lastTouchedAt: 200 },
      { path: '/ws/main.ts', status: 'modified', lastTouchedAt: 150 },
      { path: '/ws/running-agent.ts', status: 'modified', lastTouchedAt: 120 },
    ])
  })

  it('falls back to the created heuristic for a subagent Write without structured metadata', () => {
    const subagents = [
      makeSubagentWithTouch({
        parentToolUseId: 'sa-1',
        startTime: 50,
        endTime: 200,
        toolUseId: 'sa-1-w1',
        toolName: 'Write',
        input: { file_path: '/ws/agent-fresh.ts', content: 'x' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles([], subagents)

    assert.deepStrictEqual(entries, [
      { path: '/ws/agent-fresh.ts', status: 'created', lastTouchedAt: 200 },
    ])
  })

  it('applies the same result gate to subagent touches', () => {
    const subagents = [
      makeSubagentWithTouch({
        parentToolUseId: 'sa-1',
        startTime: 50,
        endTime: 200,
        toolUseId: 'sa-1-e1',
        toolName: 'Edit',
        input: { file_path: '/ws/agent-error.ts', old_string: 'a', new_string: 'b' },
        isError: true,
      }),
      makeSubagentWithTouch({
        parentToolUseId: 'sa-2',
        startTime: 60,
        endTime: 210,
        toolUseId: 'sa-2-w1',
        toolName: 'Write',
        input: { file_path: '/ws/agent-pending.ts', content: 'x' },
        omitResult: true,
      }),
    ]

    assert.deepStrictEqual(scanMessagesForTouchedFiles([], subagents), [])
  })

  it('keeps entries for absolute paths outside any workspace (membership is the panel layer’s job)', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/etc/outside.conf', old_string: 'a', new_string: 'b' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/etc/outside.conf', status: 'modified', lastTouchedAt: 10 },
    ])
  })

  it('keeps one entry for two touches of one path and orders by the later touch', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'w1',
        toolName: 'Write',
        input: { file_path: '/ws/x.ts', content: 'a' },
      }),
      makeTouchMessage({
        timestamp: 30,
        toolUseId: 'e2',
        toolName: 'Edit',
        input: { file_path: '/ws/y.ts', old_string: 'a', new_string: 'b' },
      }),
      makeTouchMessage({
        timestamp: 50,
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/ws/x.ts', old_string: 'a', new_string: 'b' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/x.ts', status: 'created', lastTouchedAt: 50 },
      { path: '/ws/y.ts', status: 'modified', lastTouchedAt: 30 },
    ])
  })

  it('normalizes equivalent spellings of one path into a single entry', () => {
    const messages = [
      makeTouchMessage({
        timestamp: 10,
        toolUseId: 'w1',
        toolName: 'Write',
        input: { file_path: '/ws/src/./b.ts', content: 'a' },
      }),
      makeTouchMessage({
        timestamp: 20,
        toolUseId: 'e1',
        toolName: 'Edit',
        input: { file_path: '/ws/src//b.ts', old_string: 'a', new_string: 'b' },
      }),
    ]

    const entries = scanMessagesForTouchedFiles(messages, [])

    assert.deepStrictEqual(entries, [
      { path: '/ws/src/b.ts', status: 'created', lastTouchedAt: 20 },
    ])
  })
})

describe('touched-files store wiring', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      messages: {},
      subagents: {},
      tasks: {},
      pendingTaskCreates: {},
      touchedFiles: {},
      totalMessageCount: {},
      historyLoadState: {},
      isLoadingMessages: {},
      activeSessionIds: {},
      pendingTurns: {},
      pendingSend: {},
      draftQueue: {},
      imageDrafts: {},
    })
  })

  function dispatchFileToolSequence(
    set: SseSetter,
    opts: {
      messageId: string
      toolUseId: string
      toolName: string
      input: unknown
      isError?: boolean
      toolUseResult?: unknown
    },
  ): void {
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: opts.messageId })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: opts.messageId,
      partIndex: 0,
      toolUseId: opts.toolUseId,
      toolName: opts.toolName,
    })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_done', {
      toolUseId: opts.toolUseId,
      input: opts.input,
    })
    handleSseEvent(set, 'ws-1', 's1', 'tool_result', {
      toolUseId: opts.toolUseId,
      output: opts.isError ? 'tool failed' : 'ok',
      isError: opts.isError === true,
      ...(opts.toolUseResult !== undefined && { toolUseResult: opts.toolUseResult }),
    })
  }

  it('adds one entry for a live tool_use_done then successful tool_result sequence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    const set = useChatStore.setState as unknown as SseSetter

    dispatchFileToolSequence(set, {
      messageId: 'm1',
      toolUseId: 'tu-1',
      toolName: 'Edit',
      input: { file_path: '/ws/src/a.ts', old_string: 'a', new_string: 'b' },
    })

    assert.deepStrictEqual(useChatStore.getState().touchedFiles['s1'], [
      { path: '/ws/src/a.ts', status: 'modified', lastTouchedAt: 5000 },
    ])
  })

  it('adds no entry when the live tool_result carries an error', () => {
    const set = useChatStore.setState as unknown as SseSetter

    dispatchFileToolSequence(set, {
      messageId: 'm1',
      toolUseId: 'tu-1',
      toolName: 'Edit',
      input: { file_path: '/ws/src/a.ts', old_string: 'missing', new_string: 'b' },
      isError: true,
    })

    assert.strictEqual(useChatStore.getState().touchedFiles['s1'], undefined)
  })

  it('keeps a single entry for repeated touches of one path and refreshes its timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    const set = useChatStore.setState as unknown as SseSetter

    dispatchFileToolSequence(set, {
      messageId: 'm1',
      toolUseId: 'tu-w1',
      toolName: 'Write',
      input: { file_path: '/ws/x.ts', content: 'a' },
    })

    vi.setSystemTime(7000)
    dispatchFileToolSequence(set, {
      messageId: 'm2',
      toolUseId: 'tu-e1',
      toolName: 'Edit',
      input: { file_path: '/ws/x.ts', old_string: 'a', new_string: 'b' },
    })

    assert.deepStrictEqual(useChatStore.getState().touchedFiles['s1'], [
      { path: '/ws/x.ts', status: 'created', lastTouchedAt: 7000 },
    ])
  })

  it('adds an entry for a subagent tool_use delta followed by a successful tool_result delta', () => {
    vi.useFakeTimers()
    vi.setSystemTime(9000)
    const set = useChatStore.setState as unknown as SseSetter

    handleSseEvent(set, 'ws-1', 's1', 'subagent_start', {
      parentToolUseId: 'task-1',
      description: 'agent',
    })
    handleSseEvent(set, 'ws-1', 's1', 'subagent_delta', {
      parentToolUseId: 'task-1',
      delta: {
        kind: 'tool_use',
        toolUseId: 'stu-1',
        toolName: 'Write',
        input: { file_path: '/ws/agent-new.ts', content: 'x' },
      },
    })
    handleSseEvent(set, 'ws-1', 's1', 'subagent_delta', {
      parentToolUseId: 'task-1',
      delta: { kind: 'tool_result', toolUseId: 'stu-1', output: 'ok', isError: false },
    })

    assert.deepStrictEqual(useChatStore.getState().touchedFiles['s1'], [
      { path: '/ws/agent-new.ts', status: 'created', lastTouchedAt: 9000 },
    ])
  })

  it('adds no entry when the subagent tool_result delta carries an error', () => {
    const set = useChatStore.setState as unknown as SseSetter

    handleSseEvent(set, 'ws-1', 's1', 'subagent_start', {
      parentToolUseId: 'task-1',
      description: 'agent',
    })
    handleSseEvent(set, 'ws-1', 's1', 'subagent_delta', {
      parentToolUseId: 'task-1',
      delta: {
        kind: 'tool_use',
        toolUseId: 'stu-1',
        toolName: 'Edit',
        input: { file_path: '/ws/agent.ts', old_string: 'a', new_string: 'b' },
      },
    })
    handleSseEvent(set, 'ws-1', 's1', 'subagent_delta', {
      parentToolUseId: 'task-1',
      delta: { kind: 'tool_result', toolUseId: 'stu-1', output: 'tool failed', isError: true },
    })

    assert.strictEqual(useChatStore.getState().touchedFiles['s1'], undefined)
  })

  it('rebuilds the full touched list from persisted file-tool activity on load (AE5)', async () => {
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({
      messages: [
        {
          id: 'h1',
          role: 'assistant',
          timestamp: 10,
          parts: [
            { type: 'tool_use', toolUseId: 'hw1', toolName: 'Write', input: { file_path: '/ws/fresh.ts', content: 'x' } },
          ],
        },
        {
          id: 'h2',
          role: 'user',
          timestamp: 11,
          parts: [
            {
              type: 'tool_result',
              toolUseId: 'hw1',
              output: 'ok',
              isError: false,
              toolUseResult: { type: 'create', filePath: '/ws/fresh.ts', content: 'x' },
            },
          ],
        },
        {
          id: 'h3',
          role: 'assistant',
          timestamp: 20,
          parts: [
            { type: 'tool_use', toolUseId: 'he1', toolName: 'Edit', input: { file_path: '/ws/existing.ts', old_string: 'a', new_string: 'b' } },
          ],
        },
        {
          id: 'h4',
          role: 'user',
          timestamp: 21,
          parts: [
            { type: 'tool_result', toolUseId: 'he1', output: 'ok', isError: false },
          ],
        },
        {
          id: 'h5',
          role: 'assistant',
          timestamp: 30,
          parts: [
            { type: 'tool_use', toolUseId: 'he2', toolName: 'Edit', input: { file_path: '/ws/failed.ts', old_string: 'a', new_string: 'b' } },
          ],
        },
        {
          id: 'h6',
          role: 'user',
          timestamp: 31,
          parts: [
            { type: 'tool_result', toolUseId: 'he2', output: 'tool failed', isError: true },
          ],
        },
      ],
      tasks: [],
      subagents: [
        {
          parentToolUseId: 'sa-1',
          description: 'agent',
          state: 'completed',
          startTime: 40,
          endTime: 50,
          toolCount: 1,
          progressHint: '',
          messages: [
            {
              id: 'sm1',
              role: 'assistant',
              parts: [
                { type: 'tool_use', toolUseId: 'se1', toolName: 'Edit', input: { file_path: '/ws/agent.ts', old_string: 'a', new_string: 'b' } },
              ],
            },
            {
              id: 'sm2',
              role: 'user',
              parts: [
                { type: 'tool_result', toolUseId: 'se1', output: 'ok', isError: false },
              ],
            },
          ],
        },
      ],
      workflows: [],
    } as never)

    try {
      await useChatStore.getState().loadMessages('ws-1', 's1')

      assert.deepStrictEqual(useChatStore.getState().touchedFiles['s1'], [
        { path: '/ws/agent.ts', status: 'modified', lastTouchedAt: 50 },
        { path: '/ws/existing.ts', status: 'modified', lastTouchedAt: 21 },
        { path: '/ws/fresh.ts', status: 'created', lastTouchedAt: 11 },
      ])
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('keeps live touches that accumulated while history was loading (merged-state rescan)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    let resolveRequest: ((value: unknown) => void) | undefined
    const response = new Promise((resolve) => {
      resolveRequest = resolve
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockReturnValue(response as never)

    try {
      const loading = useChatStore.getState().loadMessages('ws-1', 's1')

      // A live turn streams in while the history request is in flight.
      const set = useChatStore.setState as unknown as SseSetter
      dispatchFileToolSequence(set, {
        messageId: 'live-m1',
        toolUseId: 'live-tu',
        toolName: 'Edit',
        input: { file_path: '/ws/live.ts', old_string: 'a', new_string: 'b' },
      })
      assert.deepStrictEqual(useChatStore.getState().touchedFiles['s1'], [
        { path: '/ws/live.ts', status: 'modified', lastTouchedAt: 5000 },
      ])

      resolveRequest?.({
        messages: [
          {
            id: 'h1',
            role: 'assistant',
            timestamp: 10,
            parts: [
              { type: 'tool_use', toolUseId: 'hw1', toolName: 'Write', input: { file_path: '/ws/history.ts', content: 'x' } },
            ],
          },
          {
            id: 'h2',
            role: 'user',
            timestamp: 11,
            parts: [
              { type: 'tool_result', toolUseId: 'hw1', output: 'ok', isError: false },
            ],
          },
        ],
        tasks: [],
        subagents: [],
        workflows: [],
      })
      await loading

      assert.deepStrictEqual(useChatStore.getState().touchedFiles['s1'], [
        { path: '/ws/live.ts', status: 'modified', lastTouchedAt: 5000 },
        { path: '/ws/history.ts', status: 'created', lastTouchedAt: 11 },
      ])
    } finally {
      requestSpy.mockRestore()
    }
  })

  it('drops the touched-files record when the session is deleted', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true })) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)
    useChatStore.setState({
      sessions: {
        'ws-1': [
          {
            id: 's1',
            workspaceId: 'ws-1',
            name: 'Session',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      messages: {
        s1: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], timestamp: 1 }],
      },
      touchedFiles: {
        s1: [{ path: '/ws/a.ts', status: 'modified', lastTouchedAt: 1 }],
      },
    })

    try {
      const result = await useChatStore.getState().deleteSession('ws-1', 's1')
      assert.strictEqual(result.ok, true)
      assert.strictEqual(useChatStore.getState().touchedFiles['s1'], undefined)
    } finally {
      fetchFn.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('drops the touched-files record when messages are cleared (cache eviction path)', () => {
    useChatStore.setState({
      messages: {
        s1: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], timestamp: 1 }],
      },
      touchedFiles: {
        s1: [{ path: '/ws/a.ts', status: 'modified', lastTouchedAt: 1 }],
      },
    })

    useChatStore.getState().clearMessages('s1')

    assert.strictEqual(useChatStore.getState().touchedFiles['s1'], undefined)
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

describe('session_activity authoritative slice', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        'ws-1': [{
          id: 's1',
          workspaceId: 'ws-1',
          name: 'Test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      },
      messages: {},
      sessionActivity: {},
      isStreaming: {},
      unreadCompletions: {},
      activeSessionIds: {},
    })
  })

  it('hydrates a background-only session with complete task summaries', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'session_activity', {
      phase: 'background',
      active: true,
      backgroundTasks: [{ id: 'bg-1', type: 'agent', description: 'Research' }],
    })

    assert.deepStrictEqual(useChatStore.getState().sessionActivity.s1, {
      phase: 'background',
      active: true,
      backgroundTasks: [{ id: 'bg-1', type: 'agent', description: 'Research' }],
    })
    assert.strictEqual(useChatStore.getState().isStreaming.s1, true)
  })

  it('keeps the session active across foreground result until the idle snapshot', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'session_activity', {
      phase: 'background',
      active: true,
      backgroundTasks: [{ id: 'bg-1', type: 'agent', description: 'Research' }],
    })
    handleSseEvent(set, 'ws-1', 's1', 'result', {})
    assert.strictEqual(useChatStore.getState().isStreaming.s1, true)

    handleSseEvent(set, 'ws-1', 's1', 'session_activity', {
      phase: 'idle',
      active: false,
      backgroundTasks: [],
    })
    assert.strictEqual(useChatStore.getState().isStreaming.s1, false)
    assert.strictEqual(useChatStore.getState().unreadCompletions.s1, true)
  })

  it('ignores retired session_processing replay frames', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'session_activity', {
      phase: 'background',
      active: true,
      backgroundTasks: [{ id: 'bg-1', type: 'agent', description: 'Research' }],
    })
    handleSseEvent(set, 'ws-1', 's1', 'session_processing', {
      processing: false,
      backgroundTaskCount: 0,
    })

    assert.strictEqual(useChatStore.getState().sessionActivity.s1.active, true)
    assert.strictEqual(useChatStore.getState().isStreaming.s1, true)
  })

  it('routes session_activity through WebSocket and no-ops an identical hydration', () => {
    const set = useChatStore.setState as unknown as SseSetter
    const event = {
      type: 'session_activity',
      phase: 'foreground',
      active: true,
      backgroundTasks: [],
    }
    handleWsEvent(set, useChatStore.getState, {
      type: 'event',
      eventType: 'sse',
      workspaceId: 'ws-1',
      sessionId: 's1',
      data: event,
    })
    const before = useChatStore.getState()
    handleSseEvent(set, 'ws-1', 's1', 'session_activity', event)
    const after = useChatStore.getState()

    assert.strictEqual(after.sessionActivity, before.sessionActivity)
    assert.strictEqual(after.isStreaming, before.isStreaming)
  })

  it('records runtime interruption and unlocks the session', () => {
    const set = useChatStore.setState as unknown as SseSetter
    useChatStore.setState({
      sessionActivity: {
        s1: { phase: 'background', active: true, backgroundTasks: [] },
      },
      isStreaming: { s1: true },
    })
    handleSseEvent(set, 'ws-1', 's1', 'session_activity', {
      phase: 'idle',
      active: false,
      backgroundTasks: [],
      interruption: {
        reason: 'runtime_failure',
        message: 'stream died',
        foregroundInterrupted: false,
        backgroundTasks: [{ id: 'bg-1', type: 'agent', description: 'Research' }],
      },
    })

    const state = useChatStore.getState()
    assert.strictEqual(state.isStreaming.s1, false)
    assert.strictEqual(state.unreadCompletions.s1, true)
    assert.match(String(state.messages.s1[0].parts[0].type === 'text' && state.messages.s1[0].parts[0].text), /stream died/)
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

  it('retains an unpaired browser tool_use as complete history grows', () => {
    const set = useChatStore.setState as unknown as SseSetter
    handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: 'm1' })
    handleSseEvent(set, 'ws-1', 's1', 'tool_use_start', {
      messageId: 'm1',
      partIndex: 0,
      toolUseId: 't1',
      toolName: 'mcp__comate-browser__open',
    })
    assert.strictEqual(useChatStore.getState().inFlightBrowserTools['s1']?.size, 1)
    for (let i = 0; i < 60; i += 1) {
      handleSseEvent(set, 'ws-1', 's1', 'assistant_start', { messageId: `mx-${i}` })
    }
    assert.deepStrictEqual(
      [...(useChatStore.getState().inFlightBrowserTools['s1'] ?? [])],
      ['t1'],
    )
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

describe('deleteSession', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        'ws-1': [
          {
            id: 's1',
            workspaceId: 'ws-1',
            name: 'Draft Session',
            isDraft: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 's2',
            workspaceId: 'ws-1',
            name: 'Other Session',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      activeSessionIds: { 'ws-1': 's1' },
      messages: {
        s1: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], timestamp: Date.now() }],
      },
      domCache: { 'ws-1': ['s1'] },
      backgroundSessions: { 'ws-1': ['s1'] },
      sessionStatus: { s1: { pendingCount: 1 } },
      isStreaming: { s1: true },
      lastActivityAt: { s1: Date.now() },
      pendingTurns: {},
      pendingSend: {},
      draftQueue: {},
      imageDrafts: {},
    })
  })

  it('removes the session and clears its state after a successful delete', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true })) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    try {
      const result = await useChatStore.getState().deleteSession('ws-1', 's1')
      assert.strictEqual(result.ok, true)
      assert.strictEqual(
        useChatStore.getState().sessions['ws-1'].some((s) => s.id === 's1'),
        false,
      )
      assert.strictEqual(useChatStore.getState().activeSessionIds['ws-1'], undefined)
      assert.strictEqual(useChatStore.getState().messages['s1'], undefined)
      assert.strictEqual(useChatStore.getState().domCache['ws-1'].includes('s1'), false)
      assert.strictEqual(useChatStore.getState().backgroundSessions['ws-1'].includes('s1'), false)
      assert.strictEqual(useChatStore.getState().sessionStatus['s1'], undefined)
      assert.strictEqual(useChatStore.getState().isStreaming['s1'], undefined)
      assert.strictEqual(useChatStore.getState().lastActivityAt['s1'], undefined)
      assert.strictEqual(fetchFn.mock.calls.length, 1)
      assert.strictEqual((fetchFn.mock.calls[0][0] as string), '/api/workspaces/ws-1/sessions/s1')
      assert.strictEqual((fetchFn.mock.calls[0][1] as RequestInit).method, 'DELETE')
    } finally {
      fetchFn.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('returns an error and leaves state unchanged when the delete request fails', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: false, status: 500 })) as unknown as Mock &
      typeof fetch
    vi.stubGlobal('fetch', fetchFn)

    try {
      const before = useChatStore.getState().sessions['ws-1']
      const result = await useChatStore.getState().deleteSession('ws-1', 's1')
      assert.strictEqual(result.ok, false)
      assert.strictEqual(useChatStore.getState().sessions['ws-1'], before)
    } finally {
      fetchFn.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('releases a pending turn once and ignores its late acknowledgement', async () => {
    const sendRequest = deferred<unknown>()
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      type === 'sendMessage' ? sendRequest.promise : Promise.resolve({}),
    )
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true })) as unknown as Mock & typeof fetch
    vi.stubGlobal('fetch', fetchFn)
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    const image = makePromptImage('pending-delete')

    try {
      useChatStore.getState().setActiveSession('ws-1', 's1')
      await new Promise((resolve) => setTimeout(resolve, 0))
      useChatStore.setState({ serverNonce: { s1: 'nonce-1' } })
      useChatStore.getState().setImageDrafts('ws-1', 's1', [image])
      useChatStore.getState().sendMessage('ws-1', 's1', { text: '', images: [image] })

      await useChatStore.getState().deleteSession('ws-1', 's1')

      const state = useChatStore.getState()
      expect(state.pendingTurns.s1).toBeUndefined()
      expect(state.pendingSend.s1).toBeUndefined()
      expect(state.draftQueue.s1).toBeUndefined()
      expect(revokeSpy).toHaveBeenCalledTimes(1)
      expect(revokeSpy).toHaveBeenCalledWith('blob:pending-delete')

      sendRequest.resolve({ sent: true })
      await sendRequest.promise
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(revokeSpy).toHaveBeenCalledTimes(1)
      expect(useChatStore.getState().imageDrafts[promptImageDraftKey('ws-1', 's1')]).toBeUndefined()
    } finally {
      historySpy.mockRestore()
      revokeSpy.mockRestore()
      requestSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})

describe('workspace cleanup pending turns', () => {
  it('releases workspace pending turns once and never restores a late rejection', async () => {
    const sendRequest = deferred<unknown>()
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      type === 'sendMessage' ? sendRequest.promise : Promise.resolve({}),
    )
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const historySpy = vi.spyOn(useChatStore.getState(), 'addPromptHistory').mockImplementation(() => {})
    const image = makePromptImage('pending-workspace')
    useChatStore.setState({
      sessions: {
        'ws-clean': [{
          id: 'clean-session',
          workspaceId: 'ws-clean',
          name: 'Clean',
          source: 'gui',
          createdAt: '',
          updatedAt: '',
        }],
      },
      pendingTurns: {},
      pendingSend: {},
      draftQueue: {},
      drafts: {},
      imageDrafts: {},
      approvalQueue: {},
      serverNonce: {},
    })

    try {
      useChatStore.getState().setActiveSession('ws-clean', 'clean-session')
      await new Promise((resolve) => setTimeout(resolve, 0))
      useChatStore.setState({ serverNonce: { 'clean-session': 'nonce-1' } })
      useChatStore.getState().setImageDrafts('ws-clean', 'clean-session', [image])
      useChatStore.getState().sendMessage('ws-clean', 'clean-session', { text: 'submitted', images: [image] })

      useChatStore.getState().cleanupWorkspace('ws-clean')

      const state = useChatStore.getState()
      expect(state.pendingTurns['clean-session']).toBeUndefined()
      expect(state.pendingSend['clean-session']).toBeUndefined()
      expect(state.draftQueue['clean-session']).toBeUndefined()
      expect(revokeSpy).toHaveBeenCalledTimes(1)

      sendRequest.reject(new Error('late transport failure'))
      await expect(sendRequest.promise).rejects.toThrow('late transport failure')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(revokeSpy).toHaveBeenCalledTimes(1)
      expect(useChatStore.getState().drafts['clean-session']).toBeUndefined()
      expect(useChatStore.getState().imageDrafts[promptImageDraftKey('ws-clean', 'clean-session')]).toBeUndefined()
    } finally {
      historySpy.mockRestore()
      revokeSpy.mockRestore()
      requestSpy.mockRestore()
    }
  })
})

describe('activity ordering writers (turn-start keyed; KTD2/KTD3/KTD5)', () => {
  function orderingSession(
    id: string,
    workspaceId: string,
    overrides: Partial<ChatSession> = {},
  ): ChatSession {
    return {
      id,
      workspaceId,
      name: id,
      source: 'gui',
      createdAt: new Date(500).toISOString(),
      updatedAt: new Date(1000).toISOString(),
      ...overrides,
    }
  }

  function stubSessionListFetch(
    rowsByWorkspace: Record<string, ChatSession[]>,
    options: {
      workspaces?: Array<Record<string, unknown>>
      createdWorkspace?: Record<string, unknown>
      putImplementation?: () => Promise<unknown>
    } = {},
  ) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT') {
        if (options.putImplementation) return options.putImplementation()
        return { ok: true, json: async () => ({}) }
      }
      if (init?.method === 'POST' && /\/api\/workspaces\/?$/.test(url)) {
        return { ok: true, json: async () => ({ workspace: options.createdWorkspace }) }
      }
      if (url.includes('/prompt-history')) return { ok: true, json: async () => ({ prompts: [] }) }
      if (/\/api\/workspaces\/?$/.test(url)) {
        return { ok: true, json: async () => ({ workspaces: options.workspaces ?? [] }) }
      }
      const match = /\/api\/workspaces\/([^/]+)\/sessions/.exec(url)
      const rows = match ? (rowsByWorkspace[match[1]] ?? []) : []
      return { ok: true, json: async () => ({ sessions: rows }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function putCalls(fetchMock: ReturnType<typeof stubSessionListFetch>) {
    return fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    )
  }

  function sortedSessionIds(workspaceId: string): string[] {
    const state = useChatStore.getState()
    return [...(state.sessions[workspaceId] ?? [])]
      .sort((a, b) => compareSessionActivity(a, b, state.lastActivityAt))
      .map((session) => session.id)
  }

  function sortedWorkspaceIds(): string[] {
    const state = useChatStore.getState()
    return sortWorkspacesByActivity(
      useWorkspaceStore.getState().workspaces,
      state.sessions,
      state.workspaceLastTurnStartedAt,
      state.lastActivityAt,
    ).map((workspace) => workspace.id)
  }

  const idlePollStatus = (lastTurnStartedAt: number) => ({
    pendingCount: 0,
    isProcessing: false,
    activity: { phase: 'background' as const, active: false, backgroundTasks: [] },
    lastTurnStartedAt,
  })

  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      messages: {},
      activeSessionIds: {},
      sessionStatus: {},
      sessionActivity: {},
      isStreaming: {},
      unreadCompletions: {},
      lastActivityAt: {},
      workspaceLastTurnStartedAt: {},
      approvalQueue: {},
      serverNonce: {},
      pendingSend: {},
      pendingTurns: {},
      draftQueue: {},
      drafts: {},
      lastCompletion: {},
      totalMessageCount: {},
      streamStartedAt: {},
      backgroundSessions: {},
    })
  })

  afterEach(() => {
    clearAllSessionSubscriptions(useChatStore.setState as unknown as SseSetter)
  })

  it('AE1: streaming, completion, pending interactions, and key-stable poll ticks never move items', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    stubSessionListFetch({
      'ws-ord': [
        orderingSession('ord-s1', 'ws-ord', { lastTurnStartedAt: 1000 }),
        orderingSession('ord-s2', 'ws-ord', { lastTurnStartedAt: 2000 }),
      ],
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({
      statuses: {
        'ord-s1': {
          pendingCount: 1,
          pendingKind: 'approval',
          isProcessing: true,
          activity: { phase: 'background', active: true, backgroundTasks: [] },
          lastTurnStartedAt: 1000,
        },
        'ord-s2': {
          pendingCount: 0,
          isProcessing: true,
          activity: { phase: 'background', active: true, backgroundTasks: [] },
          lastTurnStartedAt: 2000,
        },
      },
      workspaceLastTurnStartedAt: 2000,
    })

    try {
      await useChatStore.getState().fetchSessions('ws-ord')
      assert.deepStrictEqual(useChatStore.getState().lastActivityAt, {
        'ord-s1': 1000,
        'ord-s2': 2000,
      })
      assert.deepStrictEqual(sortedSessionIds('ws-ord'), ['ord-s2', 'ord-s1'])

      const set = useChatStore.setState as unknown as SseSetter
      handleSseEvent(set, 'ws-ord', 'ord-s1', 'assistant_start', { messageId: 'm1' })
      handleSseEvent(set, 'ws-ord', 'ord-s1', 'pending_approval', {
        requestId: 'r1',
        toolName: 'Bash',
        toolUseId: 't1',
        input: {},
      })
      handleSseEvent(set, 'ws-ord', 'ord-s2', 'result', { isError: false })

      await vi.advanceTimersByTimeAsync(5000)

      const state = useChatStore.getState()
      // R4: the events still surface through badges and status fields.
      assert.ok((state.sessionStatus['ord-s1']?.pendingCount ?? 0) > 0)
      assert.strictEqual(state.approvalQueue['ord-s1']?.length, 1)
      assert.ok(state.lastCompletion['ord-s2'])
      // R1: but neither positions nor the ordering keys moved.
      assert.deepStrictEqual(state.lastActivityAt, { 'ord-s1': 1000, 'ord-s2': 2000 })
      assert.strictEqual(state.workspaceLastTurnStartedAt['ws-ord'], 2000)
      assert.deepStrictEqual(sortedSessionIds('ws-ord'), ['ord-s2', 'ord-s1'])
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-ord')
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('AE2: a user send moves the session and its workspace to the top, preserving other positions', async () => {
    stubSessionListFetch({
      'ws-mv': [
        orderingSession('mv-s1', 'ws-mv', { lastTurnStartedAt: 1000 }),
        orderingSession('mv-s2', 'ws-mv', { lastTurnStartedAt: 3000 }),
        orderingSession('mv-s3', 'ws-mv', { lastTurnStartedAt: 2000 }),
      ],
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      await useChatStore.getState().fetchSessions('ws-mv')
      useChatStore.getState().seedWorkspaceActivityKeys([
        { id: 'ws-mv', lastTurnStartedAt: 500 },
        { id: 'ws-mv-other', lastTurnStartedAt: 4000 },
      ])
      assert.deepStrictEqual(sortedSessionIds('ws-mv'), ['mv-s2', 'mv-s3', 'mv-s1'])

      useChatStore.getState().sendMessage('ws-mv', 'mv-s1', 'hello')

      const state = useChatStore.getState()
      const bump = state.lastActivityAt['mv-s1']
      assert.ok(bump > 3000, 'send optimistically advances the session key')
      assert.deepStrictEqual(sortedSessionIds('ws-mv'), ['mv-s1', 'mv-s2', 'mv-s3'])
      assert.strictEqual(state.workspaceLastTurnStartedAt['ws-mv'], bump)
      assert.strictEqual(state.workspaceLastTurnStartedAt['ws-mv-other'], 4000)
      const sortedWorkspaces = sortWorkspacesByActivity(
        [{ id: 'ws-mv-other' }, { id: 'ws-mv' }],
        { 'ws-mv': state.sessions['ws-mv'], 'ws-mv-other': [] },
        state.workspaceLastTurnStartedAt,
        state.lastActivityAt,
      )
      assert.deepStrictEqual(
        sortedWorkspaces.map((workspace) => workspace.id),
        ['ws-mv', 'ws-mv-other'],
      )
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-mv')
      requestSpy.mockRestore()
    }
  })

  it('AE4: selecting a session never changes ordering', async () => {
    stubSessionListFetch({
      'ws-sel': [
        orderingSession('sel-s1', 'ws-sel', { lastTurnStartedAt: 1000 }),
        orderingSession('sel-s2', 'ws-sel', { lastTurnStartedAt: 2000 }),
      ],
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      await useChatStore.getState().fetchSessions('ws-sel')
      const keysBefore = { ...useChatStore.getState().lastActivityAt }

      useChatStore.getState().setActiveSession('ws-sel', 'sel-s1')

      assert.strictEqual(useChatStore.getState().activeSessionIds['ws-sel'], 'sel-s1')
      assert.deepStrictEqual(useChatStore.getState().lastActivityAt, keysBefore)
      assert.deepStrictEqual(sortedSessionIds('ws-sel'), ['sel-s2', 'sel-s1'])
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-sel')
      requestSpy.mockRestore()
    }
  })

  it('AE5: a restart re-seeds the same order from server-carried keys', async () => {
    stubSessionListFetch(
      {
        'ws-re': [
          orderingSession('re-s1', 'ws-re', { lastTurnStartedAt: 1000 }),
          orderingSession('re-s2', 'ws-re', { lastTurnStartedAt: 3000 }),
          orderingSession('re-s3', 'ws-re', { lastTurnStartedAt: 2000 }),
        ],
      },
      {
        workspaces: [
          { id: 'ws-re', lastTurnStartedAt: 3000 },
          { id: 'ws-re-other', lastTurnStartedAt: 4000 },
        ],
      },
    )

    try {
      await useWorkspaceStore.getState().fetchWorkspaces()
      await useChatStore.getState().fetchSessions('ws-re')
      const beforeRestart = sortedSessionIds('ws-re')
      assert.deepStrictEqual(beforeRestart, ['re-s2', 're-s3', 're-s1'])
      const workspaceOrderBefore = sortedWorkspaceIds()
      assert.deepStrictEqual(workspaceOrderBefore, ['ws-re-other', 'ws-re'])

      // Simulated restart: in-memory maps vanish; the next boot re-seeds from
      // the keys carried by the server rows.
      useChatStore.setState({
        sessions: {},
        lastActivityAt: {},
        workspaceLastTurnStartedAt: {},
      })
      await useWorkspaceStore.getState().fetchWorkspaces()
      await useChatStore.getState().fetchSessions('ws-re')

      assert.deepStrictEqual(sortedSessionIds('ws-re'), beforeRestart)
      assert.deepStrictEqual(sortedWorkspaceIds(), workspaceOrderBefore)
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-re')
      useWorkspaceStore.setState({
        workspaces: [],
        activeWorkspaceId: null,
        isLoading: false,
        error: null,
      })
    }
  })

  it('AE6: a fetched previously unseen session with a creation-initialized key lands on top', async () => {
    stubSessionListFetch({
      'ws-new': [
        orderingSession('ex-s1', 'ws-new', { lastTurnStartedAt: 1000 }),
        orderingSession('ex-s2', 'ws-new', { lastTurnStartedAt: 2000 }),
      ],
    })

    try {
      await useChatStore.getState().fetchSessions('ws-new')
      assert.deepStrictEqual(sortedSessionIds('ws-new'), ['ex-s2', 'ex-s1'])

      stubSessionListFetch({
        'ws-new': [
          orderingSession('ex-s1', 'ws-new', { lastTurnStartedAt: 1000 }),
          orderingSession('ex-s2', 'ws-new', { lastTurnStartedAt: 2000 }),
          orderingSession('ex-s3', 'ws-new', { lastTurnStartedAt: 3000 }),
        ],
      })
      await useChatStore.getState().fetchSessions('ws-new')

      assert.deepStrictEqual(sortedSessionIds('ws-new'), ['ex-s3', 'ex-s2', 'ex-s1'])
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-new')
    }
  })

  it('scopes fetch pruning to the fetched workspace, keeping other workspaces’ keys', async () => {
    stubSessionListFetch({
      'ws-prune-a': [orderingSession('pa-s1', 'ws-prune-a', { lastTurnStartedAt: 1000 })],
      'ws-prune-b': [orderingSession('pb-s1', 'ws-prune-b', { lastTurnStartedAt: 500 })],
    })

    try {
      await useChatStore.getState().fetchSessions('ws-prune-a')
      await useChatStore.getState().fetchSessions('ws-prune-b')
      let keys = useChatStore.getState().lastActivityAt
      assert.strictEqual(keys['pa-s1'], 1000)
      assert.strictEqual(keys['pb-s1'], 500)

      // pb-s1 vanished server-side: only its key is pruned; ws-prune-a is untouched.
      stubSessionListFetch({
        'ws-prune-a': [orderingSession('pa-s1', 'ws-prune-a', { lastTurnStartedAt: 1000 })],
        'ws-prune-b': [],
      })
      await useChatStore.getState().fetchSessions('ws-prune-b')
      keys = useChatStore.getState().lastActivityAt
      assert.strictEqual(keys['pa-s1'], 1000)
      assert.strictEqual(keys['pb-s1'], undefined)
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-prune-a')
      useChatStore.getState().cleanupWorkspace('ws-prune-b')
    }
  })

  it('lets server-carried poll values overwrite an optimistic send bump and converge within a tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    stubSessionListFetch({
      'ws-conv': [
        orderingSession('cv-s1', 'ws-conv', { lastTurnStartedAt: 1000 }),
        orderingSession('cv-s2', 'ws-conv', { lastTurnStartedAt: 2000 }),
      ],
    })
    let pollPayload: unknown = {
      statuses: { 'cv-s1': idlePollStatus(1000), 'cv-s2': idlePollStatus(2000) },
      workspaceLastTurnStartedAt: 2000,
    }
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      Promise.resolve(type === 'status' ? pollPayload : {}),
    )

    try {
      await useChatStore.getState().fetchSessions('ws-conv')
      useChatStore.getState().seedWorkspaceActivityKeys([{ id: 'ws-conv', lastTurnStartedAt: 2000 }])

      useChatStore.getState().sendMessage('ws-conv', 'cv-s1', 'hi')
      const optimistic = useChatStore.getState().lastActivityAt['cv-s1']
      assert.ok(optimistic > 2000)
      assert.strictEqual(useChatStore.getState().workspaceLastTurnStartedAt['ws-conv'], optimistic)

      // An in-flight poll response carrying pre-send keys lands first: server
      // values are authoritative (KTD3) and overwrite the provisional bump.
      await vi.advanceTimersByTimeAsync(5000)
      assert.strictEqual(useChatStore.getState().lastActivityAt['cv-s1'], 1000)
      assert.strictEqual(useChatStore.getState().workspaceLastTurnStartedAt['ws-conv'], 2000)

      // The following tick carries the stamped turn start and the session
      // reclaims the top (convergence).
      pollPayload = {
        statuses: { 'cv-s1': idlePollStatus(optimistic + 1), 'cv-s2': idlePollStatus(2000) },
        workspaceLastTurnStartedAt: optimistic + 1,
      }
      await vi.advanceTimersByTimeAsync(5000)
      assert.strictEqual(useChatStore.getState().lastActivityAt['cv-s1'], optimistic + 1)
      assert.strictEqual(useChatStore.getState().workspaceLastTurnStartedAt['ws-conv'], optimistic + 1)
      assert.deepStrictEqual(sortedSessionIds('ws-conv'), ['cv-s1', 'cv-s2'])
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-conv')
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('corrects a failed send’s optimistic bumps downward from the next server-carried values', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    stubSessionListFetch({
      'ws-fail': [
        orderingSession('fl-s1', 'ws-fail', { lastTurnStartedAt: 1000 }),
        orderingSession('fl-s2', 'ws-fail', { lastTurnStartedAt: 2000 }),
      ],
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      Promise.resolve(
        type === 'status'
          ? {
              statuses: { 'fl-s1': idlePollStatus(1000), 'fl-s2': idlePollStatus(2000) },
              workspaceLastTurnStartedAt: 2000,
            }
          : {},
      ),
    )

    try {
      await useChatStore.getState().fetchSessions('ws-fail')
      useChatStore.getState().seedWorkspaceActivityKeys([{ id: 'ws-fail', lastTurnStartedAt: 2000 }])

      // The admission failed server-side, so no stamp ever lands; the
      // optimistic bump stays until the next server-carried value corrects it.
      useChatStore.getState().sendMessage('ws-fail', 'fl-s1', 'hi')
      assert.ok(useChatStore.getState().lastActivityAt['fl-s1'] > 2000)

      await vi.advanceTimersByTimeAsync(5000)
      assert.strictEqual(useChatStore.getState().lastActivityAt['fl-s1'], 1000)
      assert.strictEqual(useChatStore.getState().workspaceLastTurnStartedAt['ws-fail'], 2000)
      assert.deepStrictEqual(sortedSessionIds('ws-fail'), ['fl-s2', 'fl-s1'])
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-fail')
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not unarchive an archived session on the first-boot seed or a refetch without advance', async () => {
    const archived = orderingSession('ar-s1', 'ws-arch', {
      isArchived: true,
      lastTurnStartedAt: 1000,
    })
    const fetchMock = stubSessionListFetch({ 'ws-arch': [archived] })

    try {
      // First-boot seed: no stored key to compare against — exempt (KTD5).
      await useChatStore.getState().fetchSessions('ws-arch')
      assert.strictEqual(useChatStore.getState().sessions['ws-arch'][0].isArchived, true)
      assert.strictEqual(useChatStore.getState().lastActivityAt['ar-s1'], 1000)

      // Refetch with the same key: no genuine advance — still archived.
      await useChatStore.getState().fetchSessions('ws-arch')
      assert.strictEqual(useChatStore.getState().sessions['ws-arch'][0].isArchived, true)
      assert.strictEqual(putCalls(fetchMock).length, 0)
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-arch')
    }
  })

  it('unarchives an archived session when a refetch observes a genuine key advance (KTD5)', async () => {
    stubSessionListFetch({
      'ws-arch2': [orderingSession('ar2-s1', 'ws-arch2', { isArchived: true, lastTurnStartedAt: 1000 })],
    })

    try {
      await useChatStore.getState().fetchSessions('ws-arch2')
      assert.strictEqual(useChatStore.getState().sessions['ws-arch2'][0].isArchived, true)

      const fetchMock = stubSessionListFetch({
        'ws-arch2': [orderingSession('ar2-s1', 'ws-arch2', { isArchived: true, lastTurnStartedAt: 5000 })],
      })
      await useChatStore.getState().fetchSessions('ws-arch2')

      assert.strictEqual(useChatStore.getState().sessions['ws-arch2'][0].isArchived, false)
      assert.strictEqual(useChatStore.getState().lastActivityAt['ar2-s1'], 5000)
      const puts = putCalls(fetchMock)
      assert.strictEqual(puts.length, 1)
      assert.strictEqual(String(puts[0][0]), '/api/workspaces/ws-arch2/sessions/ar2-s1')
      assert.deepStrictEqual(JSON.parse((puts[0][1] as RequestInit).body as string), {
        isArchived: false,
      })
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-arch2')
    }
  })

  it('unarchives an archived session when a poll tick observes a genuine key advance (KTD5)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const fetchMock = stubSessionListFetch({
      'ws-arch3': [orderingSession('ar3-s1', 'ws-arch3', { isArchived: true, lastTurnStartedAt: 1000 })],
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      Promise.resolve(
        type === 'status'
          ? { statuses: { 'ar3-s1': idlePollStatus(5000) }, workspaceLastTurnStartedAt: 5000 }
          : {},
      ),
    )

    try {
      await useChatStore.getState().fetchSessions('ws-arch3')
      assert.strictEqual(useChatStore.getState().sessions['ws-arch3'][0].isArchived, true)

      await vi.advanceTimersByTimeAsync(5000)

      assert.strictEqual(useChatStore.getState().sessions['ws-arch3'][0].isArchived, false)
      assert.strictEqual(useChatStore.getState().lastActivityAt['ar3-s1'], 5000)
      assert.strictEqual(putCalls(fetchMock).length, 1)
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-arch3')
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not double-fire the unarchive when the refetch lands before the poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    stubSessionListFetch({
      'ws-arch4': [orderingSession('ar4-s1', 'ws-arch4', { isArchived: true, lastTurnStartedAt: 1000 })],
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockImplementation((type) =>
      Promise.resolve(
        type === 'status'
          ? { statuses: { 'ar4-s1': idlePollStatus(5000) }, workspaceLastTurnStartedAt: 5000 }
          : {},
      ),
    )

    try {
      await useChatStore.getState().fetchSessions('ws-arch4')

      // The focus refetch lands between the server stamp and the next poll:
      // it observes the advance and unarchives.
      const fetchMock = stubSessionListFetch({
        'ws-arch4': [orderingSession('ar4-s1', 'ws-arch4', { isArchived: true, lastTurnStartedAt: 5000 })],
      })
      await useChatStore.getState().fetchSessions('ws-arch4')
      assert.strictEqual(useChatStore.getState().sessions['ws-arch4'][0].isArchived, false)

      // The poll tick then carries the same key: no advance, no second PUT.
      await vi.advanceTimersByTimeAsync(5000)
      assert.strictEqual(putCalls(fetchMock).length, 1)
      assert.strictEqual(useChatStore.getState().lastActivityAt['ar4-s1'], 5000)
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-arch4')
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('unarchives an archived session on a user send (send writer observes the advance)', async () => {
    const fetchMock = stubSessionListFetch({
      'ws-arch5': [orderingSession('ar5-s1', 'ws-arch5', { isArchived: true, lastTurnStartedAt: 1000 })],
    })
    const requestSpy = vi.spyOn(wsClient, 'request').mockResolvedValue({})

    try {
      await useChatStore.getState().fetchSessions('ws-arch5')
      assert.strictEqual(useChatStore.getState().sessions['ws-arch5'][0].isArchived, true)

      useChatStore.getState().sendMessage('ws-arch5', 'ar5-s1', 'wake')

      assert.strictEqual(useChatStore.getState().sessions['ws-arch5'][0].isArchived, false)
      assert.ok(useChatStore.getState().lastActivityAt['ar5-s1'] > 1000)
      assert.strictEqual(putCalls(fetchMock).length, 1)
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-arch5')
      requestSpy.mockRestore()
    }
  })

  it('seeds and authoritatively overwrites workspace keys from server rows', () => {
    useChatStore.getState().seedWorkspaceActivityKeys([
      { id: 'wk-1', lastTurnStartedAt: 100 },
      { id: 'wk-2' },
    ])
    assert.deepStrictEqual(useChatStore.getState().workspaceLastTurnStartedAt, { 'wk-1': 100 })

    // KTD3: a later server-carried value overwrites, even downward.
    useChatStore.getState().seedWorkspaceActivityKeys([{ id: 'wk-1', lastTurnStartedAt: 50 }])
    assert.strictEqual(useChatStore.getState().workspaceLastTurnStartedAt['wk-1'], 50)
  })

  it('cleanupWorkspace keeps the workspace ordering key, leaving positions unchanged', () => {
    useChatStore.getState().seedWorkspaceActivityKeys([
      { id: 'wk-gone', lastTurnStartedAt: 1234 },
      { id: 'wk-stay', lastTurnStartedAt: 99 },
    ])

    useChatStore.getState().cleanupWorkspace('wk-gone')

    // The map is bounded by workspace count and re-seeded by the next
    // fetchWorkspaces/poll; a lingering entry for a deleted workspace is never
    // read, and the surviving workspace's position is unchanged.
    const keys = useChatStore.getState().workspaceLastTurnStartedAt
    assert.strictEqual(keys['wk-gone'], 1234)
    assert.strictEqual(keys['wk-stay'], 99)
    const sorted = sortWorkspacesByActivity([{ id: 'wk-stay' }, { id: 'wk-gone' }], {}, keys, {})
    assert.deepStrictEqual(
      sorted.map((workspace) => workspace.id),
      ['wk-gone', 'wk-stay'],
    )
  })

  it('restores the archived flag locally when the unarchive PUT rejects', async () => {
    stubSessionListFetch({
      'ws-putfail': [
        orderingSession('pf-s1', 'ws-putfail', { isArchived: true, lastTurnStartedAt: 1000 }),
      ],
    })

    try {
      await useChatStore.getState().fetchSessions('ws-putfail')
      assert.strictEqual(useChatStore.getState().sessions['ws-putfail'][0].isArchived, true)

      // A genuine advance flips the local row and fires the persist PUT, which
      // then fails: the local archived flag is restored.
      const fetchMock = stubSessionListFetch(
        {
          'ws-putfail': [
            orderingSession('pf-s1', 'ws-putfail', { isArchived: true, lastTurnStartedAt: 5000 }),
          ],
        },
        { putImplementation: () => Promise.reject(new Error('network down')) },
      )
      await useChatStore.getState().fetchSessions('ws-putfail')
      assert.strictEqual(useChatStore.getState().sessions['ws-putfail'][0].isArchived, false)

      // Flush the rejected PUT's catch handler.
      await new Promise((resolve) => setTimeout(resolve, 0))

      assert.strictEqual(useChatStore.getState().sessions['ws-putfail'][0].isArchived, true)
      assert.strictEqual(putCalls(fetchMock).length, 1)
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-putfail')
    }
  })

  it('does not re-archive a session when a refetch lands while the unarchive PUT is pending', async () => {
    stubSessionListFetch({
      'ws-pend': [
        orderingSession('pd-s1', 'ws-pend', { isArchived: true, lastTurnStartedAt: 1000 }),
      ],
    })

    try {
      await useChatStore.getState().fetchSessions('ws-pend')
      assert.strictEqual(useChatStore.getState().sessions['ws-pend'][0].isArchived, true)

      // The advance unarchives locally while the persist PUT hangs in flight.
      const putInFlight = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
      stubSessionListFetch(
        {
          'ws-pend': [
            orderingSession('pd-s1', 'ws-pend', { isArchived: true, lastTurnStartedAt: 5000 }),
          ],
        },
        { putImplementation: () => putInFlight.promise },
      )
      await useChatStore.getState().fetchSessions('ws-pend')
      assert.strictEqual(useChatStore.getState().sessions['ws-pend'][0].isArchived, false)

      // A refetch carrying the stale (still-archived) server row at the same
      // key must not re-archive the session before the PUT settles.
      stubSessionListFetch({
        'ws-pend': [
          orderingSession('pd-s1', 'ws-pend', { isArchived: true, lastTurnStartedAt: 5000 }),
        ],
      })
      await useChatStore.getState().fetchSessions('ws-pend')
      assert.strictEqual(useChatStore.getState().sessions['ws-pend'][0].isArchived, false)

      putInFlight.resolve({ ok: true, json: async () => ({}) })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      useChatStore.getState().cleanupWorkspace('ws-pend')
    }
  })

  it('fetchWorkspaces seeds the workspace ordering map from server-carried keys (R5)', async () => {
    stubSessionListFetch(
      {},
      {
        workspaces: [
          { id: 'wk-a', lastTurnStartedAt: 500 },
          { id: 'wk-b', lastTurnStartedAt: 9000 },
          { id: 'wk-c' },
        ],
      },
    )

    try {
      await useWorkspaceStore.getState().fetchWorkspaces()

      assert.deepStrictEqual(useChatStore.getState().workspaceLastTurnStartedAt, {
        'wk-a': 500,
        'wk-b': 9000,
      })
      assert.deepStrictEqual(sortedWorkspaceIds(), ['wk-b', 'wk-a', 'wk-c'])
    } finally {
      useWorkspaceStore.setState({
        workspaces: [],
        activeWorkspaceId: null,
        isLoading: false,
        error: null,
      })
    }
  })

  it('createWorkspace seeds the creation-initialized ordering key (R6)', async () => {
    stubSessionListFetch(
      {},
      {
        createdWorkspace: {
          id: 'wk-new',
          name: 'Fresh',
          folderPath: '/tmp/fresh',
          createdAt: new Date(100).toISOString(),
          lastTurnStartedAt: 4242,
        },
      },
    )

    try {
      const workspace = await useWorkspaceStore.getState().createWorkspace({
        name: 'Fresh',
        folderPath: '/tmp/fresh',
      })

      assert.strictEqual(workspace?.id, 'wk-new')
      assert.strictEqual(useChatStore.getState().workspaceLastTurnStartedAt['wk-new'], 4242)
    } finally {
      useWorkspaceStore.setState({
        workspaces: [],
        activeWorkspaceId: null,
        isLoading: false,
        error: null,
      })
    }
  })
})
