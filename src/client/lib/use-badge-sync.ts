import { useEffect } from 'react'
import { isDesktop, updateBadgeState } from './desktop-api'
import { useChatStore } from '../stores/chat-store'

export function computeTotalPendingCount(
  sessionStatus: Record<string, { pendingCount: number } | undefined>,
): number {
  let total = 0
  for (const status of Object.values(sessionStatus)) {
    total += status?.pendingCount ?? 0
  }
  return total
}

export function useBadgeSync(): void {
  const totalPendingCount = useChatStore((s) => {
    let total = 0
    for (const status of Object.values(s.sessionStatus)) {
      total += status?.pendingCount ?? 0
    }
    return total
  })

  useEffect(() => {
    if (!isDesktop()) return

    updateBadgeState(totalPendingCount).catch((err) => {
      console.error('Failed to update badge state:', err)
    })
  }, [totalPendingCount])
}
