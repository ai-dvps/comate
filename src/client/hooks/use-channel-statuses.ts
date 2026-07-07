import { useEffect, useState } from 'react'

export type ChannelStatus = 'connected' | 'disconnected' | 'error' | 'not_configured' | 'connecting'

export type BotPrefix = 'bot' | 'feishuBot'

export const CHANNEL_STATUS_CLASS: Record<ChannelStatus, string> = {
  connected: 'opacity-100',
  disconnected: 'opacity-40 grayscale',
  error: 'opacity-100',
  not_configured: 'opacity-40 grayscale',
  connecting: 'opacity-100',
}

export const CHANNEL_STATUS_DOT: Record<ChannelStatus, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-text-tertiary',
  error: 'bg-warning',
  not_configured: 'bg-text-tertiary',
  // Blue brand dot + pulse so the in-flight state reads as "working" without
  // relying on color alone (the rest of the dot language is green/grey/amber).
  connecting: 'bg-blue-500 animate-pulse',
}

export function getChannelStatusLabel(status: ChannelStatus, t: (key: string) => string, prefix: BotPrefix): string {
  const keyMap: Record<ChannelStatus, string> = {
    connected: `${prefix}Connected`,
    disconnected: `${prefix}Disconnected`,
    error: `${prefix}Error`,
    not_configured: `${prefix}NotConfigured`,
    connecting: `${prefix}Connecting`,
  }
  return t(`workspaceTabs.${keyMap[status]}`)
}

/**
 * Polls a channel status endpoint for the given workspaces on a fixed cadence.
 * Shared by every bot indicator surface so they use identical polling
 * lifecycle semantics (fetch on mount + interval, clear when empty).
 *
 * The hook queries the server for every candidate workspace and returns a
 * status only when a bot is actually bound (`not_configured` is omitted so
 * callers can simply check `statuses[ws.id]`). Callers should pass a stable
 * array (e.g. a store slice or a useMemo'd list) so the effect does not
 * restart on every render.
 */
export function useChannelStatuses(
  workspaceIds: string[],
  endpoint: string,
): Record<string, ChannelStatus> {
  const [statuses, setStatuses] = useState<Record<string, ChannelStatus>>({})

  useEffect(() => {
    if (workspaceIds.length === 0) {
      setStatuses({})
      return
    }

    const fetchStatuses = async () => {
      const results = await Promise.all(
        workspaceIds.map(async (id) => {
          try {
            const res = await fetch(`/api/workspaces/${id}${endpoint}`)
            if (!res.ok) return { id, status: 'error' as ChannelStatus }
            const data = await res.json()
            return { id, status: (data.status as ChannelStatus) ?? 'error' }
          } catch {
            return { id, status: 'error' as ChannelStatus }
          }
        }),
      )
      const next: Record<string, ChannelStatus> = {}
      for (const { id, status } of results) {
        if (status !== 'not_configured') {
          next[id] = status
        }
      }
      setStatuses(next)
    }

    fetchStatuses()
    const interval = setInterval(fetchStatuses, 5000)
    return () => clearInterval(interval)
  }, [workspaceIds, endpoint])

  return statuses
}
