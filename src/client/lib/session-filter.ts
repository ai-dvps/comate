import type { ChatSession } from '../stores/chat-store'

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
