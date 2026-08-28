import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommandsStore } from './commands-store'

const originalFetch = global.fetch

describe('commands store session-scoped discovery', () => {
  beforeEach(() => {
    useCommandsStore.setState({
      commandsByWorkspace: {},
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('requests commands for the active backend session', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      commands: [{ name: 'review', description: 'Review changes' }],
      partial: false,
    })))
    global.fetch = fetchMock as typeof fetch

    await useCommandsStore.getState().fetchCommands('workspace-1', {
      sessionId: 'session/one',
      backendId: 'opencode',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/commands?sessionId=session%2Fone&backend=opencode',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('does not share cached commands between backend sessions', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      const name = url.includes('session-1') ? 'first-session' : 'second-session'
      return Promise.resolve(Response.json({
        commands: [{ name, description: '' }],
        partial: false,
      }))
    })
    global.fetch = fetchMock as typeof fetch

    await useCommandsStore.getState().fetchCommands('workspace-1', { sessionId: 'session-1' })
    await useCommandsStore.getState().fetchCommands('workspace-1', { sessionId: 'session-2' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Object.values(useCommandsStore.getState().commandsByWorkspace))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ commands: [expect.objectContaining({ name: 'first-session' })] }),
        expect.objectContaining({ commands: [expect.objectContaining({ name: 'second-session' })] }),
      ]))
  })

  it('identifies the selected backend before a new chat has a session', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      commands: [],
      partial: false,
    })))
    global.fetch = fetchMock as typeof fetch

    await useCommandsStore.getState().fetchCommands('workspace-1', { backendId: 'opencode' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/commands?backend=opencode',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('does not share new-chat command caches between backends', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const backend = String(input).includes('backend=opencode') ? 'opencode' : 'claude'
      return Promise.resolve(Response.json({
        commands: [{ name: backend, description: '' }],
        partial: false,
      }))
    })
    global.fetch = fetchMock as typeof fetch

    await useCommandsStore.getState().fetchCommands('workspace-1', { backendId: 'opencode' })
    await useCommandsStore.getState().fetchCommands('workspace-1', { backendId: 'claude' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clears every session-scoped cache entry for a deleted workspace', () => {
    useCommandsStore.setState({
      commandsByWorkspace: {
        'workspace-1': { commands: [], partial: false },
        'workspace-1?sessionId=session-1': { commands: [], partial: false },
        'workspace-1?backend=opencode': { commands: [], partial: false },
        'workspace-2?sessionId=session-2': { commands: [], partial: false },
      },
      loadingByWorkspace: {
        'workspace-1?sessionId=session-1': true,
        'workspace-1?backend=opencode': true,
        'workspace-2?sessionId=session-2': true,
      },
      errorByWorkspace: {
        'workspace-1?sessionId=session-1': 'failed',
        'workspace-1?backend=opencode': 'failed',
        'workspace-2?sessionId=session-2': 'failed',
      },
    })

    useCommandsStore.getState().clearCommandsForWorkspace('workspace-1')

    const state = useCommandsStore.getState()
    expect(Object.keys(state.commandsByWorkspace)).toEqual(['workspace-2?sessionId=session-2'])
    expect(Object.keys(state.loadingByWorkspace)).toEqual(['workspace-2?sessionId=session-2'])
    expect(Object.keys(state.errorByWorkspace)).toEqual(['workspace-2?sessionId=session-2'])
  })
})
