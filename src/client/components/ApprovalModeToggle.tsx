import { useTranslation } from 'react-i18next'
import { useChatStore, type ApprovalMode } from '../stores/chat-store'
import { Shield, ShieldCheck, ShieldAlert, ChevronDown } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

interface ApprovalModeToggleCommonProps {
  workspaceId: string
  disabled?: boolean
  hideNameBelowSm?: boolean
}

interface SessionApprovalModeToggleProps extends ApprovalModeToggleCommonProps {
  mode?: 'session'
  sessionId: string
}

interface NewChatApprovalModeToggleProps extends ApprovalModeToggleCommonProps {
  mode: 'new-chat'
  approvalMode: ApprovalMode
  onApprovalModeChange: (approvalMode: ApprovalMode) => void
}

type ApprovalModeToggleProps = SessionApprovalModeToggleProps | NewChatApprovalModeToggleProps

const APPROVAL_MODES: ApprovalMode[] = ['auto', 'readonly', 'manual']

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
    icon: ShieldCheck,
    color: 'text-green-400',
    bg: 'bg-green-400/10',
    border: 'border-green-400/25',
    hoverBg: 'hover:bg-green-400/20',
    activeClass: 'bg-green-400/10 text-green-400 border-green-400/30',
  },
  readonly: {
    icon: Shield,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    border: 'border-amber-400/25',
    hoverBg: 'hover:bg-amber-400/20',
    activeClass: 'bg-amber-400/10 text-amber-400 border-amber-400/30',
  },
  auto: {
    icon: ShieldAlert,
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    border: 'border-red-400/25',
    hoverBg: 'hover:bg-red-400/20',
    activeClass: 'bg-red-400/10 text-red-400 border-red-400/30',
  },
}

export default function ApprovalModeToggle(props: ApprovalModeToggleProps) {
  const { workspaceId, disabled = false, hideNameBelowSm = false } = props
  const isNewChat = props.mode === 'new-chat'
  const sessionId = isNewChat ? null : props.sessionId
  const { t } = useTranslation(['chat', 'settings'])

  const session = useChatStore((s) =>
    sessionId ? s.sessions[workspaceId]?.find((ses) => ses.id === sessionId) : undefined,
  )
  const setApprovalMode = useChatStore((s) => s.setSessionApprovalMode)

  const currentMode: ApprovalMode = isNewChat ? props.approvalMode : session?.approvalMode || 'manual'
  const meta = MODE_META[currentMode]
  const Icon = meta.icon

  const handleSelect = (mode: ApprovalMode) => {
    if (isNewChat) {
      props.onApprovalModeChange(mode)
    } else {
      setApprovalMode(workspaceId, props.sessionId, mode)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed ${meta.color} hover:bg-surface-hover`}
          title={t(`approvalMode.${currentMode}Desc`)}
        >
          <Icon className="w-3 h-3" />
          <span className={hideNameBelowSm ? 'hidden sm:inline' : ''}>
            {t(`settings:general.approvalModes.${currentMode}`)}
          </span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label={t('settings:general.defaultApprovalMode')}
        side="top"
        align="end"
        sideOffset={6}
        className="bg-surface-active border border-border rounded-lg shadow-lg p-1 z-50 min-w-[160px]"
      >
        {APPROVAL_MODES.map((mode) => {
          const m = MODE_META[mode]
          const ModeIcon = m.icon
          const isActive = mode === currentMode
          return (
            <button
              key={mode}
              role="menuitem"
              aria-label={t(`settings:general.approvalModes.${mode}`)}
              title={t(`settings:general.approvalModes.${mode}`)}
              onClick={() => handleSelect(mode)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors ${
                isActive
                  ? m.activeClass
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              <ModeIcon className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? '' : 'text-text-tertiary'}`} />
              <div className="min-w-0">
                <div className="font-medium">{t(`settings:general.approvalModes.${mode}`)}</div>
                <div className="text-[10px] text-text-tertiary">{t(`approvalMode.${mode}Desc`)}</div>
              </div>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
