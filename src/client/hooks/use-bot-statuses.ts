import { useEffect, useState } from 'react'

export type BotStatus = 'connected' | 'disconnected' | 'error' | 'not_configured' | 'connecting'

export type BotPrefix = 'bot' | 'feishuBot'

export const BOT_STATUS_CLASS: Record<BotStatus, string> = {
  connected: 'opacity-100',
  disconnected: 'opacity-40 grayscale',
  error: 'opacity-100',
  not_configured: 'opacity-40 grayscale',
  connecting: 'opacity-100',
}

export const BOT_STATUS_DOT: Record<BotStatus, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-text-tertiary',
  error: 'bg-warning',
  not_configured: 'bg-text-tertiary',
  // Blue brand dot + pulse so the in-flight state reads as "working" without
  // relying on color alone (the rest of the dot language is green/grey/amber).
  connecting: 'bg-blue-500 animate-pulse',
}

export function getBotStatusLabel(status: BotStatus, t: (key: string) => string, prefix: BotPrefix): string {
  const keyMap: Record<BotStatus, string> = {
    connected: `${prefix}Connected`,
    disconnected: `${prefix}Disconnected`,
    error: `${prefix}Error`,
    not_configured: `${prefix}NotConfigured`,
    connecting: `${prefix}Connecting`,
  }
  return t(`workspaceTabs.${keyMap[status]}`)
}

/**
 * Polls a bot status endpoint for bot-enabled workspaces on a fixed cadence.
 * Shared by every bot indicator surface so they use identical polling
 * lifecycle semantics (fetch on mount + interval, clear when none enabled).
 *
 * `workspaceIds` are the candidate ids; only those whose workspace has the
 * `enabledKey` flag set are actually polled. Callers should pass a stable
 * array (e.g. a store slice or a useMemo'd list) so the effect does not
 * restart on every render.
 */
export function useBotStatuses(
  workspaceIds: string[],
  workspaces: Array<{ id: string; settings: Record<string, unknown> }>,
  enabledKey: 'wecomBotEnabled' | 'feishuBotEnabled',
  endpoint: string,
): Record<string, BotStatus> {
  const [statuses, setStatuses] = useState<Record<string, BotStatus>>({})

  useEffect(() => {
    const enabledIds = workspaceIds.filter((id) => {
      const ws = workspaces.find((w) => w.id === id)
      return ws?.settings[enabledKey]
    })
    if (enabledIds.length === 0) {
      setStatuses({})
      return
    }

    const fetchStatuses = async () => {
      const results = await Promise.all(
        enabledIds.map(async (id) => {
          try {
            const res = await fetch(`/api/workspaces/${id}${endpoint}`)
            if (!res.ok) return { id, status: 'error' as BotStatus }
            const data = await res.json()
            return { id, status: (data.status as BotStatus) ?? 'error' }
          } catch {
            return { id, status: 'error' as BotStatus }
          }
        }),
      )
      const next: Record<string, BotStatus> = {}
      for (const { id, status } of results) {
        next[id] = status
      }
      setStatuses(next)
    }

    fetchStatuses()
    const interval = setInterval(fetchStatuses, 5000)
    return () => clearInterval(interval)
  }, [workspaceIds, workspaces, enabledKey, endpoint])

  return statuses
}
