import type { TFunction } from 'i18next'
import { MessageSquare, Pencil, Shield, ShieldAlert } from 'lucide-react'
import { shouldSubmitOnEnter } from '../lib/keyboard'
import { deriveSessionState } from '../lib/session-status'
import type { ChatSession } from '../stores/chat-store'
import StatusIndicator from './StatusIndicator'
import { cn } from './ui/utils'

function formatRelativeDate(dateStr: string, t: TFunction): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t('time.justNow')
  if (diffMins < 60) return t('time.minAgo', { count: diffMins })
  if (diffHours < 24) return t('time.hourAgo', { count: diffHours })
  if (diffDays < 7) return t('time.dayAgo', { count: diffDays })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getSessionTimestamp(session: ChatSession, t: TFunction): string {
  if (session.lastModified) {
    return formatRelativeDate(new Date(session.lastModified).toISOString(), t)
  }
  return formatRelativeDate(session.updatedAt, t)
}

export interface SessionListItemProps {
  session: ChatSession
  displayName: string
  isActive: boolean
  isStreaming: boolean
  pendingCount: number
  unread: boolean
  preview: string
  editingSessionId: string | null
  editingName: string
  useModifierToSubmit: boolean
  onStartEdit: (session: ChatSession) => void
  onCommitEdit: (sessionId: string) => void
  onCancelEdit: () => void
  onSetEditingName: (name: string) => void
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  onActivate: (sessionId: string) => void
  t: TFunction
}

export default function SessionListItem({
  session,
  displayName,
  isActive,
  isStreaming,
  pendingCount,
  unread,
  preview,
  editingSessionId,
  editingName,
  useModifierToSubmit,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onSetEditingName,
  onContextMenu,
  onActivate,
  t,
}: SessionListItemProps) {
  const rowState = deriveSessionState({
    isStreaming,
    pendingCount,
    unread,
    isActive,
  })

  return (
    <div
      key={session.id}
      onClick={() => onActivate(session.id)}
      onContextMenu={(e) => onContextMenu(e, session.id)}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'session-item px-3 py-2.5 cursor-pointer group transition-all mx-2 rounded-lg',
        isActive ? 'bg-surface-active' : 'hover:bg-surface-hover',
      )}
    >
      <div className="flex items-start gap-2">
        {rowState === 'idle' ? (
          <MessageSquare
            className={cn(
              'w-3.5 h-3.5 flex-shrink-0 mt-0.5',
              isActive ? 'text-accent' : 'text-text-tertiary',
            )}
          />
        ) : (
          <StatusIndicator state={rowState} className="mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {editingSessionId === session.id ? (
              <input
                autoFocus
                value={editingName}
                onChange={(e) => onSetEditingName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (shouldSubmitOnEnter(e, useModifierToSubmit)) {
                    e.preventDefault()
                    onCommitEdit(session.id)
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancelEdit()
                  }
                }}
                onBlur={() => onCancelEdit()}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 px-2 py-0.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary"
              />
            ) : (
              <>
                <p
                  className={cn(
                    'text-xs truncate',
                    isActive ? 'text-text-primary font-medium' : 'text-text-secondary',
                  )}
                >
                  {displayName}
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onStartEdit(session)
                  }}
                  className={cn(
                    'p-0.5 rounded hover:bg-surface-hover text-text-tertiary hover:text-text-secondary transition-opacity opacity-0 group-hover:opacity-100',
                  )}
                  title={t('renameSession')}
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
          <p className="text-[11px] text-text-tertiary truncate mt-0.5">{preview}</p>
          <div className="flex items-center gap-1.5 mt-1">
            {session.isDraft && (
              <span className="px-1 py-0.5 text-[9px] bg-warning/20 text-warning rounded">
                {t('draft')}
              </span>
            )}
            {session.isWip && (
              <span className="px-1 py-0.5 text-[9px] bg-purple-500/20 text-purple-400 rounded">
                {t('wip')}
              </span>
            )}
            {session.isArchived && (
              <span className="px-1 py-0.5 text-[9px] bg-slate-500/20 text-slate-400 rounded">
                {t('archived')}
              </span>
            )}
            {session.approvalMode && session.approvalMode !== 'manual' && (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] rounded',
                  session.approvalMode === 'auto'
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-amber-500/20 text-amber-400',
                )}
              >
                {session.approvalMode === 'auto' ? (
                  <ShieldAlert className="w-2.5 h-2.5" />
                ) : (
                  <Shield className="w-2.5 h-2.5" />
                )}
                {t(`approvalMode.${session.approvalMode}`)}
              </span>
            )}
            {session.source === 'wecom' && (
              <img
                src="/wecom-icon.svg"
                alt="WeCom"
                className={cn(
                  'w-3 h-3 flex-shrink-0',
                  !isActive && 'grayscale opacity-40',
                )}
                title={t('wecomBotSession')}
              />
            )}
            {session.source === 'feishu' && (
              <img
                src="/feishu-icon.svg"
                alt="Feishu"
                className={cn(
                  'w-3 h-3 flex-shrink-0',
                  !isActive && 'grayscale opacity-40',
                )}
                title={t('feishuBotSession')}
              />
            )}
            <span className="text-[10px] text-text-tertiary/60">
              {getSessionTimestamp(session, t)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
