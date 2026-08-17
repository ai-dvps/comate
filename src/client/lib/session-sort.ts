import type { ChatSession } from '../stores/chat-store'

export function getSessionActivityTimestamp(
  session: ChatSession,
  lastActivityAt: Record<string, number>,
): number {
  return lastActivityAt[session.id]
    ?? session.lastModified
    ?? (Date.parse(session.updatedAt) || 0)
}

export function compareSessionActivity(
  a: ChatSession,
  b: ChatSession,
  lastActivityAt: Record<string, number>,
): number {
  const aTimestamp = getSessionActivityTimestamp(a, lastActivityAt)
  const bTimestamp = getSessionActivityTimestamp(b, lastActivityAt)
  if (aTimestamp !== bTimestamp) {
    return bTimestamp - aTimestamp
  }

  const aUpdated = a.lastModified ?? (Date.parse(a.updatedAt) || 0)
  const bUpdated = b.lastModified ?? (Date.parse(b.updatedAt) || 0)
  if (aUpdated !== bUpdated) {
    return bUpdated - aUpdated
  }

  const aCreated = Date.parse(a.createdAt) || 0
  const bCreated = Date.parse(b.createdAt) || 0
  if (aCreated !== bCreated) {
    return bCreated - aCreated
  }

  return a.id.localeCompare(b.id)
}
