import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTranslation } from 'react-i18next'
import { Folder, X } from 'lucide-react'
import StatusIndicator from './StatusIndicator'

type BotStatus = 'connected' | 'disconnected' | 'error' | 'not_configured'

function getBotStatusLabel(status: BotStatus, t: (key: string) => string): string {
  const labels: Record<BotStatus, string> = {
    connected: t('workspaceTabs.botConnected'),
    disconnected: t('workspaceTabs.botDisconnected'),
    error: t('workspaceTabs.botError'),
    not_configured: t('workspaceTabs.botNotConfigured'),
  }
  return labels[status]
}

const BOT_STATUS_CLASS: Record<BotStatus, string> = {
  connected: 'opacity-100',
  disconnected: 'opacity-40 grayscale',
  error: 'opacity-100',
  not_configured: 'opacity-40 grayscale',
}

const BOT_STATUS_DOT: Record<BotStatus, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-text-tertiary',
  error: 'bg-warning',
  not_configured: 'bg-text-tertiary',
}

export default function WorkspaceTabs() {
  const { t } = useTranslation('settings')
  const { workspaces, openWorkspaceIds, activeWorkspaceId, setActiveWorkspace, closeWorkspace } = useWorkspaceStore()

  const sessions = useChatStore((s) => s.sessions)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const unreadCompletions = useChatStore((s) => s.unreadCompletions)
  const activeSessionIds = useChatStore((s) => s.activeSessionIds)

  const [botStatuses, setBotStatuses] = useState<Record<string, BotStatus>>({})

  useEffect(() => {
    const enabledIds = openWorkspaceIds.filter((id) => {
      const ws = workspaces.find((w) => w.id === id)
      return ws?.settings.wecomBotEnabled
    })
    if (enabledIds.length === 0) {
      setBotStatuses({})
      return
    }

    const fetchStatuses = async () => {
      const results = await Promise.all(
        enabledIds.map(async (id) => {
          try {
            const res = await fetch(`/api/workspaces/${id}/bot/status`)
            if (!res.ok) return { id, status: 'error' as BotStatus }
            const data = await res.json()
            return { id, status: (data.status as BotStatus) ?? 'error' }
          } catch {
            return { id, status: 'error' as BotStatus }
          }
        })
      )
      const next: Record<string, BotStatus> = {}
      for (const { id, status } of results) {
        next[id] = status
      }
      setBotStatuses(next)
    }

    fetchStatuses()
    const interval = setInterval(fetchStatuses, 5000)
    return () => clearInterval(interval)
  }, [openWorkspaceIds, workspaces])

  const getWorkspaceCounts = (workspaceId: string) => {
    const list = sessions[workspaceId] ?? []
    const activeId = activeSessionIds[workspaceId]
    let needsMe = 0
    let finishedUnread = 0
    let streaming = 0
    for (const s of list) {
      if ((sessionStatus[s.id]?.pendingCount ?? 0) > 0) needsMe++
      if (unreadCompletions[s.id] && s.id !== activeId) finishedUnread++
      if (isStreaming[s.id]) streaming++
    }
    return { needsMe, finishedUnread, streaming }
  }

  const openWorkspaces = openWorkspaceIds
    .map((id) => workspaces.find((w) => w.id === id))
    .filter(Boolean)

  return (
    <div className="flex items-center gap-1">
      {openWorkspaces.map((ws) => {
        if (!ws) return null
        const isActive = activeWorkspaceId === ws.id
        const counts = getWorkspaceCounts(ws.id)
        const botStatus = botStatuses[ws.id]
        return (
          <div
            key={ws.id}
            className={`tab-pill flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer text-xs transition-all group ${
              isActive
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'
            }`}
            onClick={() => setActiveWorkspace(ws.id)}
            role="tab"
            aria-selected={isActive}
          >
            <Folder className={`w-3 h-3 flex-shrink-0 ${isActive ? 'text-accent' : 'text-text-tertiary'}`} />
            <span className="truncate max-w-[100px]">{ws.name}</span>
            {botStatus && (
              <span className="relative inline-flex flex-shrink-0" title={getBotStatusLabel(botStatus, t)}>
                <img
                  src="/wecom-icon.svg"
                  alt="WeCom"
                  className={`w-3 h-3 flex-shrink-0 ${BOT_STATUS_CLASS[botStatus]}`}
                />
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${BOT_STATUS_DOT[botStatus]} ring-1 ring-bg`}
                />
              </span>
            )}
            {counts.needsMe > 0 && <StatusIndicator state="needs-me" count={counts.needsMe} />}
            {counts.finishedUnread > 0 && <StatusIndicator state="finished-unread" count={counts.finishedUnread} />}
            {counts.streaming > 0 && <StatusIndicator state="streaming" count={counts.streaming} />}
            {openWorkspaces.length > 1 && (
              <button
                className={`ml-0.5 p-0.5 rounded hover:bg-surface-hover hover:text-destructive transition-all ${
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeWorkspace(ws.id)
                }}
                aria-label={t('workspaceTabs.closeTab', { name: ws.name })}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
