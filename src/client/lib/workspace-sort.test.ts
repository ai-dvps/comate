import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { ChatSession } from '../stores/chat-store'
import { getWorkspaceActivityTimestamp, sortWorkspacesByActivity } from './workspace-sort'

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    name: 'Session',
    createdAt: new Date(500).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    ...overrides,
  }
}

const workspaces = [
  { id: 'workspace-1', name: 'One' },
  { id: 'workspace-2', name: 'Two' },
  { id: 'workspace-3', name: 'Three' },
]

describe('workspace activity sorting', () => {
  it('uses the newest Session activity in each Workspace', () => {
    const sessions = {
      'workspace-1': [
        makeSession({ id: 'older', workspaceId: 'workspace-1', updatedAt: new Date(1000).toISOString() }),
        makeSession({ id: 'newer', workspaceId: 'workspace-1', updatedAt: new Date(2000).toISOString() }),
      ],
      'workspace-2': [
        makeSession({ id: 'latest', workspaceId: 'workspace-2', updatedAt: new Date(1500).toISOString() }),
      ],
    }

    assert.strictEqual(getWorkspaceActivityTimestamp(sessions['workspace-1'], {}), 2000)
    assert.deepStrictEqual(
      sortWorkspacesByActivity(workspaces, sessions, {}, { latest: 3000 }).map(({ id }) => id),
      ['workspace-2', 'workspace-1', 'workspace-3'],
    )
  })

  it('prefers the server-carried workspace key over session-derived activity', () => {
    const sessions = {
      'workspace-1': [
        makeSession({ id: 'hot', workspaceId: 'workspace-1', updatedAt: new Date(9000).toISOString() }),
      ],
      'workspace-2': [
        makeSession({ id: 'warm', workspaceId: 'workspace-2', updatedAt: new Date(500).toISOString() }),
      ],
    }

    // workspace-1's own sessions are newer, but its server key is older, and
    // the server key is the primary source for that workspace (KTD2/KTD3).
    assert.deepStrictEqual(
      sortWorkspacesByActivity(workspaces, sessions, { 'workspace-1': 100 }, {}).map(({ id }) => id),
      ['workspace-2', 'workspace-1', 'workspace-3'],
    )
  })

  it('places a zero-session Workspace with a seeded key on top (new workspace, R6)', () => {
    const sessions = {
      'workspace-1': [
        makeSession({ id: 's', workspaceId: 'workspace-1', updatedAt: new Date(1000).toISOString() }),
      ],
    }

    assert.deepStrictEqual(
      sortWorkspacesByActivity(workspaces, sessions, { 'workspace-3': 5000 }, {}).map(({ id }) => id),
      ['workspace-3', 'workspace-1', 'workspace-2'],
    )
  })

  it('uses Session metadata fallbacks when live activity is absent', () => {
    const sessions = {
      'workspace-1': [makeSession({ workspaceId: 'workspace-1', lastModified: 2500 })],
      'workspace-2': [makeSession({ workspaceId: 'workspace-2', updatedAt: new Date(2000).toISOString() })],
    }

    assert.deepStrictEqual(
      sortWorkspacesByActivity(workspaces, sessions, {}, {}).map(({ id }) => id),
      ['workspace-1', 'workspace-2', 'workspace-3'],
    )
  })

  it('falls back to createdAt for Workspaces with no key and no sessions', () => {
    const dated = [
      { id: 'a', createdAt: new Date(1000).toISOString() },
      { id: 'b', createdAt: new Date(3000).toISOString() },
      { id: 'c', createdAt: new Date(2000).toISOString() },
    ]

    assert.deepStrictEqual(
      sortWorkspacesByActivity(dated, {}, {}, {}).map(({ id }) => id),
      ['b', 'c', 'a'],
    )
  })

  it('places empty Workspaces last and preserves stable ties', () => {
    const sessions = {
      'workspace-1': [makeSession({ id: 'one', workspaceId: 'workspace-1' })],
      'workspace-2': [makeSession({ id: 'two', workspaceId: 'workspace-2' })],
      'workspace-3': [],
    }
    const original = [...workspaces]

    assert.deepStrictEqual(
      sortWorkspacesByActivity(workspaces, sessions, {}, {}).map(({ id }) => id),
      ['workspace-1', 'workspace-2', 'workspace-3'],
    )
    assert.deepStrictEqual(workspaces, original)
  })

  it('preserves source order when every Workspace is empty', () => {
    assert.deepStrictEqual(
      sortWorkspacesByActivity(workspaces, {}, {}, {}).map(({ id }) => id),
      ['workspace-1', 'workspace-2', 'workspace-3'],
    )
  })
})
