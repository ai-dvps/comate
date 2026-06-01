import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../stores/chat-store'
import { isTauri } from './tauri-api'

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
    if (!isTauri()) return

    invoke('update_badge_state', { count: totalPendingCount }).catch((err) => {
      console.error('Failed to update badge state:', err)
    })
  }, [totalPendingCount])
}
