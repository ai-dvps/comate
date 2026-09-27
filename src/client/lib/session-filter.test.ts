import { describe, it } from 'node:test'
import assert from 'node:assert'
import { getSessionDisplayName, matchesSessionQuery, matchesSessionStatus, isBotSession } from './session-filter'
import type { ChatSession } from '../stores/chat-store'

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    workspaceId: 'ws1',
    name: 'Default Name',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('isBotSession', () => {
  it('returns true for wecom and feishu sources', () => {
    assert.strictEqual(isBotSession('wecom'), true)
    assert.strictEqual(isBotSession('feishu'), true)
  })

  it('returns false for gui, undefined, and unknown sources', () => {
    assert.strictEqual(isBotSession('gui'), false)
    assert.strictEqual(isBotSession(undefined), false)
    assert.strictEqual(isBotSession('other'), false)
  })
})

describe('getSessionDisplayName', () => {
  it('prefers customTitle over summary and name', () => {
    const session = makeSession({ customTitle: 'Custom', summary: 'Summary', name: 'Name' })
    assert.strictEqual(getSessionDisplayName(session), 'Custom')
  })

  it('prefers summary when customTitle is absent', () => {
    const session = makeSession({ summary: 'Summary', name: 'Name' })
    assert.strictEqual(getSessionDisplayName(session), 'Summary')
  })

  it('falls back to name when nothing else is set', () => {
    const session = makeSession({ name: 'Name' })
    assert.strictEqual(getSessionDisplayName(session), 'Name')
  })

  it('strips the WeCom: prefix for wecom sessions', () => {
    const session = makeSession({ source: 'wecom', name: 'WeCom: Support Chat' })
    assert.strictEqual(getSessionDisplayName(session), 'Support Chat')
  })

  it('does not strip WeCom: for non-wecom sessions', () => {
    const session = makeSession({ source: 'gui', name: 'WeCom: Not WeCom' })
    assert.strictEqual(getSessionDisplayName(session), 'WeCom: Not WeCom')
  })
})

describe('matchesSessionQuery', () => {
  it('returns true for substring matches regardless of case', () => {
    const session = makeSession({ name: 'Project Alpha' })
    assert.strictEqual(matchesSessionQuery(session, 'proj'), true)
    assert.strictEqual(matchesSessionQuery(session, 'ALPHA'), true)
  })

  it('returns false when query does not match', () => {
    const session = makeSession({ name: 'Project Alpha' })
    assert.strictEqual(matchesSessionQuery(session, 'beta'), false)
  })

  it('returns true for empty or whitespace-only queries', () => {
    const session = makeSession({ name: 'Project Alpha' })
    assert.strictEqual(matchesSessionQuery(session, ''), true)
    assert.strictEqual(matchesSessionQuery(session, '   '), true)
  })

  it('matches against the visible display name including customTitle and summary', () => {
    const byTitle = makeSession({ customTitle: 'Design System', name: 'Untitled' })
    assert.strictEqual(matchesSessionQuery(byTitle, 'design'), true)

    const bySummary = makeSession({ summary: 'Backend migration', name: 'Untitled' })
    assert.strictEqual(matchesSessionQuery(bySummary, 'migration'), true)
  })
})

describe('matchesSessionStatus', () => {
  it('active filter excludes archived sessions and includes non-archived sessions', () => {
    const archived = makeSession({ isArchived: true })
    const active = makeSession({ isArchived: false })
    assert.strictEqual(matchesSessionStatus(archived, 'active'), false)
    assert.strictEqual(matchesSessionStatus(active, 'active'), true)
  })

  it('archived filter includes sessions that are also wip', () => {
    const archivedWip = makeSession({ isArchived: true, isWip: true })
    assert.strictEqual(matchesSessionStatus(archivedWip, 'archived'), true)
  })

  it('wip filter includes wip sessions even if they are archived', () => {
    const archivedWip = makeSession({ isArchived: true, isWip: true })
    const plainWip = makeSession({ isArchived: false, isWip: true })
    assert.strictEqual(matchesSessionStatus(archivedWip, 'wip'), true)
    assert.strictEqual(matchesSessionStatus(plainWip, 'wip'), true)
  })

  it('all filter returns true for any session', () => {
    assert.strictEqual(matchesSessionStatus(makeSession({ isArchived: true }), 'all'), true)
    assert.strictEqual(matchesSessionStatus(makeSession({ isWip: true }), 'all'), true)
    assert.strictEqual(matchesSessionStatus(makeSession({}), 'all'), true)
  })

  it('active filter includes wip sessions that are not archived', () => {
    const wip = makeSession({ isWip: true, isArchived: false })
    assert.strictEqual(matchesSessionStatus(wip, 'active'), true)
  })

  it('archived filter excludes non-archived sessions', () => {
    const active = makeSession({ isArchived: false })
    assert.strictEqual(matchesSessionStatus(active, 'archived'), false)
  })
})
