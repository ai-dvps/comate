import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { useAppSettings } from '../hooks/use-app-settings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

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

/** App-global Claude Code output style setting. */
export default function OutputStyleSetting() {
  const { t } = useTranslation('chat')
  const { outputStyle, setOutputStyle } = useAppSettings()
  const [isReady, setIsReady] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void loadOutputStyle().then((value) => {
      if (!alive) return
      if (value === undefined) {
        setError(t('outputStyle.loadError'))
        return
      }
      setOutputStyle(value)
      setIsReady(true)
    })
    return () => {
      alive = false
    }
  }, [setOutputStyle, t])

  const effective = outputStyle ?? 'default'
  const styles = BUILTIN_OUTPUT_STYLES.includes(effective as (typeof BUILTIN_OUTPUT_STYLES)[number])
    ? BUILTIN_OUTPUT_STYLES
    : [...BUILTIN_OUTPUT_STYLES, effective]

  const handleChange = async (style: string) => {
    if (style === effective) return
    const previous = outputStyle
    const next = style === 'default' ? null : style
    setOutputStyle(next)
    setIsSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/output-style', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outputStyle: next }),
      })
      if (!response.ok) throw new Error('Failed to save output style')
    } catch {
      setOutputStyle(previous)
      setError(t('outputStyle.saveError'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 sm:pr-6">
          <label htmlFor="claude-output-style" className="text-sm font-medium text-text-primary">
            {t('outputStyle.selectorTitle')}
          </label>
          <p id="claude-output-style-description" className="mt-1 text-xs leading-5 text-text-tertiary">
            {t('outputStyle.description')}
          </p>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <Select
            value={effective}
            onValueChange={(value) => void handleChange(value)}
            disabled={!isReady || isSaving}
          >
            <SelectTrigger
              id="claude-output-style"
              aria-describedby="claude-output-style-description"
              className="h-10 w-full min-w-44 sm:w-48"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {styles.map((style) => (
                <SelectItem key={style} value={style}>
                  {t(STYLE_LABEL_KEYS[style] ?? style)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isSaving && (
            <span role="status" aria-label={t('outputStyle.saving')}>
              <Loader2 className="h-4 w-4 animate-spin text-text-tertiary motion-reduce:animate-none" aria-hidden="true" />
            </span>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
