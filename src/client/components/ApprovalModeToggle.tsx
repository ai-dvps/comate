import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, type ApprovalMode } from '../stores/chat-store'
import { Shield, ShieldCheck, ShieldAlert } from 'lucide-react'

interface ApprovalModeToggleProps {
  workspaceId: string
  sessionId: string
}

const MODE_ICONS: Record<ApprovalMode, typeof Shield> = {
  manual: ShieldAlert,
  readonly: Shield,
  auto: ShieldCheck,
}

export default function ApprovalModeToggle({ workspaceId, sessionId }: ApprovalModeToggleProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const setApprovalMode = useChatStore((s) => s.setSessionApprovalMode)

  const currentMode: ApprovalMode = session?.approvalMode || 'manual'
  const Icon = MODE_ICONS[currentMode]

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const handleSelect = (mode: ApprovalMode) => {
    setApprovalMode(workspaceId, sessionId, mode)
    setOpen(false)
  }

  const modes: ApprovalMode[] = ['manual', 'readonly', 'auto']

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-surface-hover transition-colors"
        title={t(`approvalMode.${currentMode}Desc`)}
      >
        <Icon className="w-3 h-3 text-text-tertiary" />
        <span className="text-text-tertiary">{t(`approvalMode.${currentMode}`)}</span>
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 min-w-[160px] bg-surface-active border border-border rounded-lg shadow-lg py-1">
          {modes.map((mode) => {
            const ModeIcon = MODE_ICONS[mode]
            return (
              <button
                key={mode}
                onClick={() => handleSelect(mode)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  mode === currentMode
                    ? 'text-accent bg-accent/10'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <ModeIcon className="w-3.5 h-3.5 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium">{t(`approvalMode.${mode}`)}</div>
                  <div className="text-[10px] text-text-tertiary">{t(`approvalMode.${mode}Desc`)}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
