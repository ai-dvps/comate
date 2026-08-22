import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Sparkles } from 'lucide-react'
import { useCommandsStore } from '../stores/commands-store'
import { useAppSettings } from '../hooks/use-app-settings'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

interface OutputStyleSelectProps {
  workspaceId: string
  disabled?: boolean
  hideNameBelowSm?: boolean
}

/**
 * CLI built-in output styles (2.1.237+). 'default' is the sentinel for "no
 * explicit style" — it clears the app-global setting back to the CLI default.
 */
const BUILTIN_OUTPUT_STYLES = ['default', 'explanatory', 'learning', 'concise'] as const

const STYLE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  BUILTIN_OUTPUT_STYLES.map((name) => [name, `outputStyle.${name}`]),
)

let outputStyleRequest: Promise<string | null | undefined> | null = null

function loadOutputStyle(): Promise<string | null | undefined> {
  if (!outputStyleRequest) {
    outputStyleRequest = fetch('/api/settings/output-style')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) =>
        data && (data.outputStyle === null || typeof data.outputStyle === 'string')
          ? data.outputStyle
          : undefined,
      )
      .catch(() => undefined)
      .finally(() => {
        outputStyleRequest = null
      })
  }
  return outputStyleRequest
}

/**
 * Output style selector (CLI 2.1.237+: Default / Explanatory / Learning /
 * Concise / workspace custom styles). The choice is app-global and applies to
 * every Claude runtime; cached runtimes are rebuilt before their next turn.
 */
export default function OutputStyleSelect(props: OutputStyleSelectProps) {
  const { workspaceId, disabled = false, hideNameBelowSm = false } = props
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const { outputStyle, setOutputStyle } = useAppSettings()

  const commandsByWorkspace = useCommandsStore((s) => s.commandsByWorkspace[workspaceId])
  const fetchCommands = useCommandsStore((s) => s.fetchCommands)

  useEffect(() => {
    if (!commandsByWorkspace) {
      fetchCommands(workspaceId)
    }
  }, [fetchCommands, commandsByWorkspace, workspaceId])

  useEffect(() => {
    let alive = true
    void loadOutputStyle().then((value) => {
      if (alive && value !== undefined) {
        setOutputStyle(value)
      }
    }).finally(() => {
      if (alive) setIsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [setOutputStyle])

  // Built-ins first, then any custom style the CLI reports for this workspace.
  const extras = (commandsByWorkspace?.outputStyles ?? []).filter(
    (name) => !BUILTIN_OUTPUT_STYLES.includes(name as (typeof BUILTIN_OUTPUT_STYLES)[number]),
  )
  const styles = [...BUILTIN_OUTPUT_STYLES, ...extras]

  const effective = outputStyle ?? 'default'
  const label = t(STYLE_LABEL_KEYS[effective] ?? effective)

  const handleSelect = async (style: string) => {
    setOpen(false)
    if (style === effective) return
    const previous = outputStyle
    const next = style === 'default' ? null : style
    setOutputStyle(next)
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings/output-style', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outputStyle: next }),
      })
      if (!response.ok) throw new Error('Failed to save output style')
    } catch {
      setOutputStyle(previous)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || !isLoaded || isSaving}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed text-text-secondary hover:bg-surface-hover hover:text-text-primary"
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
              onClick={() => void handleSelect(style)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors ${
                isActive
                  ? 'bg-surface-active text-text-primary'
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
