import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { Folder, X } from 'lucide-react'
import StatusIndicator from './StatusIndicator'

export default function WorkspaceTabs() {
  const { workspaces, openWorkspaceIds, activeWorkspaceId, setActiveWorkspace, closeWorkspace } = useWorkspaceStore()

  const sessions = useChatStore((s) => s.sessions)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const unreadCompletions = useChatStore((s) => s.unreadCompletions)
  const activeSessionIds = useChatStore((s) => s.activeSessionIds)

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
    .map(id => workspaces.find(w => w.id === id))
    .filter(Boolean)

  return (
    <div className="flex items-center gap-1">
      {openWorkspaces.map(ws => {
        if (!ws) return null
        const isActive = activeWorkspaceId === ws.id
        const counts = getWorkspaceCounts(ws.id)
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
                aria-label={`Close ${ws.name}`}
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
