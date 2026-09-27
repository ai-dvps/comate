import { describe, it } from 'node:test'
import assert from 'node:assert'
import { compareSessionActivity, getSessionActivityTimestamp } from './session-sort'
import type { ChatSession } from '../stores/chat-store'

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const now = new Date()
  return {
    id: 's1',
    workspaceId: 'ws1',
    name: 'Default Name',
    createdAt: new Date(now.getTime() - 86400000).toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  }
}

describe('compareSessionActivity', () => {
  it('projects the same primary activity timestamp used by the comparator', () => {
    const session = makeSession({
      id: 'a',
      lastModified: 2000,
      updatedAt: new Date(1000).toISOString(),
    })

    assert.strictEqual(getSessionActivityTimestamp(session, { a: 3000 }), 3000)
    assert.strictEqual(getSessionActivityTimestamp(session, {}), 2000)
    assert.strictEqual(
      getSessionActivityTimestamp(makeSession({ updatedAt: new Date(1000).toISOString() }), {}),
      1000,
    )
  })

  it('sorts a more-recently active session above a less-recent one', () => {
    const a = makeSession({ id: 'a' })
    const b = makeSession({ id: 'b' })
    const lastActivityAt = { a: 2000, b: 1000 }
    assert.ok(compareSessionActivity(a, b, lastActivityAt) < 0)
    assert.ok(compareSessionActivity(b, a, lastActivityAt) > 0)
  })

  it('falls back to session timestamps when lastActivityAt is missing', () => {
    const a = makeSession({
      id: 'a',
      updatedAt: new Date(2000).toISOString(),
    })
    const b = makeSession({
      id: 'b',
      updatedAt: new Date(1000).toISOString(),
    })
    assert.ok(compareSessionActivity(a, b, {}) < 0)
    assert.ok(compareSessionActivity(b, a, {}) > 0)
  })

  it('uses lastModified over updatedAt when present', () => {
    const a = makeSession({
      id: 'a',
      lastModified: 500,
      updatedAt: new Date(2000).toISOString(),
    })
    const b = makeSession({
      id: 'b',
      lastModified: 1000,
      updatedAt: new Date(1000).toISOString(),
    })
    assert.ok(compareSessionActivity(a, b, {}) > 0)
  })

  it('falls back to updatedAt then createdAt when lastActivityAt is tied', () => {
    const a = makeSession({
      id: 'a',
      updatedAt: new Date(2000).toISOString(),
      createdAt: new Date(500).toISOString(),
    })
    const b = makeSession({
      id: 'b',
      updatedAt: new Date(1000).toISOString(),
      createdAt: new Date(1500).toISOString(),
    })
    const lastActivityAt = { a: 3000, b: 3000 }
    assert.ok(compareSessionActivity(a, b, lastActivityAt) < 0)
  })

  it('sorts by id ascending when every timestamp matches', () => {
    const a = makeSession({ id: 'a' })
    const b = makeSession({ id: 'b' })
    assert.strictEqual(compareSessionActivity(a, b, {}), -1)
    assert.strictEqual(compareSessionActivity(b, a, {}), 1)
    assert.strictEqual(compareSessionActivity(a, a, {}), 0)
  })
})
