import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useBackendStore, backendAvailability, type BackendId } from '../stores/backend-store'
import { ChevronDown, Check, Lock, Cpu } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

interface BackendSelectorCommonProps {
  workspaceId: string
  disabled?: boolean
  hideNameBelowSm?: boolean
}

interface SessionBackendSelectorProps extends BackendSelectorCommonProps {
  mode?: 'session'
  sessionId: string
}

interface NewChatBackendSelectorProps extends BackendSelectorCommonProps {
  mode: 'new-chat'
  backendId: BackendId | null
  onBackendChange: (backendId: BackendId) => void
}

type BackendSelectorProps = SessionBackendSelectorProps | NewChatBackendSelectorProps

const BACKEND_LABEL_KEYS: Record<string, string> = {
  claude: 'backend.claude',
  opencode: 'backend.opencode',
  codex: 'backend.codex',
}

/**
 * Agent backend selector (U5). Draft sessions pick from available backends
 * (R3 — unavailable backends are never listed); once the session carries a
 * backend it renders as a locked badge (R4). Bot sessions are hidden by the
 * caller (R14).
 */
export default function BackendSelector(props: BackendSelectorProps) {
  const { workspaceId, disabled = false, hideNameBelowSm = false } = props
  const isNewChat = props.mode === 'new-chat'
  const sessionId = isNewChat ? null : props.sessionId
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)

  const session = useChatStore((s) =>
    sessionId ? s.sessions[workspaceId]?.find((ses) => ses.id === sessionId) : undefined,
  )
  const setSessionBackend = useChatStore((s) => s.setSessionBackend)

  const backends = useBackendStore((s) => s.backends)
  const defaultBackend = useBackendStore((s) => s.defaultBackend)
  const fetchBackends = useBackendStore((s) => s.fetchBackends)

  useEffect(() => {
    if (backends.length === 0) {
      fetchBackends()
    }
  }, [fetchBackends, backends.length])

  const lockedBackend = isNewChat ? props.backendId : session?.backend
  // The lock materializes at the first message (R4): a draft is always
  // re-selectable, even when a backend is already pre-selected.
  const isLocked = !isNewChat && !!session?.backend && !session?.isDraft
  const effectiveBackend = (lockedBackend ?? defaultBackend ?? 'claude') as BackendId
  const availability = backendAvailability(backends, effectiveBackend)
  const label = t(BACKEND_LABEL_KEYS[effectiveBackend] ?? effectiveBackend)

  // Locked: non-interactive badge with availability signal (R4).
  if (isLocked) {
    const unavailable = availability?.status === 'unavailable'
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium ${
          unavailable ? 'text-destructive' : 'text-text-tertiary'
        }`}
        title={
          unavailable
            ? t('backend.unavailableReadOnly', { backend: label })
            : t('backend.locked', { backend: label })
        }
      >
        <Lock className="w-3 h-3" />
        <span className={hideNameBelowSm ? 'hidden sm:inline' : ''}>{label}</span>
      </span>
    )
  }

  const selectable = backends.filter((b) => b.availability.status === 'available')

  const handleSelect = (backend: BackendId) => {
    if (backend === effectiveBackend) {
      setOpen(false)
      return
    }
    if (isNewChat) {
      props.onBackendChange(backend)
    } else {
      void setSessionBackend(workspaceId, props.sessionId, backend)
    }
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || selectable.length === 0}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          title={t('backend.selectorTitle')}
        >
          <Cpu className="w-3.5 h-3.5" />
          <span className={`max-w-[120px] truncate ${hideNameBelowSm ? 'hidden sm:inline' : ''}`}>{label}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="bg-surface-active border border-border rounded-lg shadow-lg p-1 z-50 min-w-[200px]"
      >
        <div className="px-2 py-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
          {t('backend.selectorTitle')}
        </div>
        {selectable.map((backend) => {
          const isActive = backend.id === effectiveBackend
          return (
            <button
              key={backend.id}
              onClick={() => handleSelect(backend.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors ${
                isActive
                  ? 'bg-surface-active text-text-primary'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              <Cpu className="w-4 h-4 flex-shrink-0 opacity-70" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{t(BACKEND_LABEL_KEYS[backend.id] ?? backend.id)}</div>
              </div>
              <Check className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? '' : 'opacity-0'}`} />
            </button>
          )
        })}
        {selectable.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-text-tertiary text-center">
            {t('backend.noneAvailable')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
