import { useTranslation } from 'react-i18next'
import { useChatStore, type ApprovalMode } from '../stores/chat-store'
import { Shield, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

interface ApprovalModeToggleProps {
  workspaceId: string
  sessionId: string
}

const MODE_META: Record<
  ApprovalMode,
  {
    icon: typeof Shield
    color: string
    bg: string
    border: string
    hoverBg: string
    activeClass: string
  }
> = {
  manual: {
    icon: ShieldAlert,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    border: 'border-amber-400/25',
    hoverBg: 'hover:bg-amber-400/20',
    activeClass: 'bg-amber-400/10 text-amber-400 border-amber-400/30',
  },
  readonly: {
    icon: Shield,
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    border: 'border-blue-400/25',
    hoverBg: 'hover:bg-blue-400/20',
    activeClass: 'bg-blue-400/10 text-blue-400 border-blue-400/30',
  },
  auto: {
    icon: ShieldCheck,
    color: 'text-green-400',
    bg: 'bg-green-400/10',
    border: 'border-green-400/25',
    hoverBg: 'hover:bg-green-400/20',
    activeClass: 'bg-green-400/10 text-green-400 border-green-400/30',
  },
}

export default function ApprovalModeToggle({ workspaceId, sessionId }: ApprovalModeToggleProps) {
  const { t } = useTranslation('chat')

  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const setApprovalMode = useChatStore((s) => s.setSessionApprovalMode)

  const currentMode: ApprovalMode = session?.approvalMode || 'manual'
  const meta = MODE_META[currentMode]
  const Icon = meta.icon

  const handleSelect = (mode: ApprovalMode) => {
    setApprovalMode(workspaceId, sessionId, mode)
  }

  const modes: ApprovalMode[] = ['manual', 'readonly', 'auto']

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${meta.bg} ${meta.border} ${meta.color} ${meta.hoverBg}`}
          title={t(`approvalMode.${currentMode}Desc`)}
        >
          <Icon className="w-3 h-3" />
          <span>{t(`approvalMode.${currentMode}`)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="bg-surface-active border border-border rounded-lg shadow-lg p-1 z-50 min-w-[160px]"
      >
        {modes.map((mode) => {
          const m = MODE_META[mode]
          const ModeIcon = m.icon
          const isActive = mode === currentMode
          return (
            <button
              key={mode}
              onClick={() => handleSelect(mode)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors ${
                isActive
                  ? m.activeClass
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              <ModeIcon className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? '' : 'text-text-tertiary'}`} />
              <div className="min-w-0">
                <div className="font-medium">{t(`approvalMode.${mode}`)}</div>
                <div className="text-[10px] text-text-tertiary">{t(`approvalMode.${mode}Desc`)}</div>
              </div>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
