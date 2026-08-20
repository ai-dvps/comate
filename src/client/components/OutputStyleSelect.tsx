import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Sparkles } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import { useCommandsStore } from '../stores/commands-store'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { useState } from 'react'

interface OutputStyleSelectCommonProps {
  workspaceId: string
  disabled?: boolean
  hideNameBelowSm?: boolean
}

interface SessionOutputStyleSelectProps extends OutputStyleSelectCommonProps {
  mode?: 'session'
  sessionId: string
}

interface NewChatOutputStyleSelectProps extends OutputStyleSelectCommonProps {
  mode: 'new-chat'
  outputStyle: string | null
  onOutputStyleChange: (outputStyle: string | null) => void
}

type OutputStyleSelectProps =
  | SessionOutputStyleSelectProps
  | NewChatOutputStyleSelectProps

/**
 * CLI built-in output styles (2.1.237+). 'default' is the sentinel for "no
 * explicit style" — it clears the session field back to the CLI default.
 */
const BUILTIN_OUTPUT_STYLES = ['default', 'explanatory', 'learning', 'concise'] as const

const STYLE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  BUILTIN_OUTPUT_STYLES.map((name) => [name, `outputStyle.${name}`]),
)

/**
 * Output style selector (CLI 2.1.237+: Default / Explanatory / Learning /
 * Concise / workspace custom styles). The choice is persisted on the session
 * and applied via inline settings at runtime creation; changing it on a live
 * session rebuilds the runtime so the next turn uses the new style.
 */
export default function OutputStyleSelect(props: OutputStyleSelectProps) {
  const { workspaceId, disabled = false, hideNameBelowSm = false } = props
  const isNewChat = props.mode === 'new-chat'
  const sessionId = isNewChat ? null : props.sessionId
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)

  const session = useChatStore((s) =>
    sessionId ? s.sessions[workspaceId]?.find((ses) => ses.id === sessionId) : undefined,
  )
  const setSessionOutputStyle = useChatStore((s) => s.setSessionOutputStyle)

  const commandsByWorkspace = useCommandsStore((s) => s.commandsByWorkspace[workspaceId])
  const fetchCommands = useCommandsStore((s) => s.fetchCommands)

  useEffect(() => {
    if (!commandsByWorkspace) {
      fetchCommands(workspaceId)
    }
  }, [fetchCommands, commandsByWorkspace, workspaceId])

  // Built-ins first, then any custom style the CLI reports for this workspace.
  const extras = (commandsByWorkspace?.outputStyles ?? []).filter(
    (name) => !BUILTIN_OUTPUT_STYLES.includes(name as (typeof BUILTIN_OUTPUT_STYLES)[number]),
  )
  const styles = [...BUILTIN_OUTPUT_STYLES, ...extras]

  const current = isNewChat ? props.outputStyle : session?.outputStyle ?? null
  const effective = current ?? 'default'
  const label = t(STYLE_LABEL_KEYS[effective] ?? effective)

  const handleSelect = (style: string) => {
    setOpen(false)
    if (style === effective) return
    // 'default' clears the explicit style; anything else sets it.
    const next = style === 'default' ? null : style
    if (isNewChat) {
      props.onOutputStyleChange(next)
    } else {
      void setSessionOutputStyle(workspaceId, props.sessionId, next)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed text-accent hover:bg-surface-hover"
          title={t('outputStyle.selectorTitle')}
        >
          <Sparkles className="w-3.5 h-3.5" />
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
          {t('outputStyle.selectorTitle')}
        </div>
        {styles.map((style) => {
          const isActive = style === effective
          return (
            <button
              key={style}
              onClick={() => handleSelect(style)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors ${
                isActive
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">
                  {t(STYLE_LABEL_KEYS[style] ?? style)}
                </div>
              </div>
              <Check className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? '' : 'opacity-0'}`} />
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
