import type { ChatSession } from '../stores/chat-store'

export function isBotSession(source?: string): boolean {
  return source === 'wecom' || source === 'feishu'
}

export function getSessionDisplayName(session: ChatSession): string {
  const name = session.customTitle || session.summary || session.name
  if (session.source === 'wecom' && name.startsWith('WeCom: ')) {
    return name.slice(7)
  }
  return name
}

export function matchesSessionQuery(session: ChatSession, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const displayName = getSessionDisplayName(session).toLowerCase()
  return displayName.includes(needle)
}

export type SessionStatusFilter = 'all' | 'active' | 'archived' | 'wip'

export function matchesSessionStatus(session: ChatSession, status: SessionStatusFilter): boolean {
  switch (status) {
    case 'all':
      return true
    case 'active':
      return !session.isArchived
    case 'archived':
      return !!session.isArchived
    case 'wip':
      return !!session.isWip
    default:
      return true
  }
}
