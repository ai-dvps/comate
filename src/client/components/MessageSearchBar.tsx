import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ChevronUp, ChevronDown, Loader2 } from 'lucide-react'

export interface MessageSearchBarProps {
  query: string
  onQueryChange: (query: string) => void
  currentMatchIndex: number
  totalMatches: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  isSearching?: boolean
}

export default function MessageSearchBar({
  query,
  onQueryChange,
  currentMatchIndex,
  totalMatches,
  onNext,
  onPrev,
  onClose,
  isSearching = false,
}: MessageSearchBarProps) {
  const { t } = useTranslation('chat')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) {
          onPrev()
        } else {
          onNext()
        }
      }
    }

    const input = inputRef.current
    input?.addEventListener('keydown', handleKeyDown)
    return () => input?.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onNext, onPrev])

  const counterText =
    totalMatches === 0 ? '0/0' : `${currentMatchIndex + 1}/${totalMatches}`
  const hasQuery = query.length > 0
  const canNavigate = totalMatches > 0

  return (
    <div
      className="absolute top-3 right-3 z-50 flex items-center gap-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
      role="search"
      aria-label={t('messageSearchPlaceholder')}
    >
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('messageSearchPlaceholder')}
          className="h-8 w-48 rounded border border-border bg-bg px-2 pr-7 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none sm:w-64"
          aria-label={t('messageSearchPlaceholder')}
        />
        {isSearching && (
          <Loader2 className="pointer-events-none absolute right-2 h-3.5 w-3.5 animate-spin text-text-tertiary" />
        )}
        {!isSearching && hasQuery && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            className="absolute right-1.5 rounded p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
            aria-label={t('messageSearchClear')}
            tabIndex={-1}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div
        className="min-w-[2.5rem] text-center text-xs text-text-secondary"
        aria-live="polite"
        aria-atomic="true"
      >
        {counterText}
      </div>

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={!canNavigate}
          className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t('messageSearchPrevious')}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNavigate}
          className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t('messageSearchNext')}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          aria-label={t('messageSearchClose')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {hasQuery && totalMatches === 0 && !isSearching && (
        <span className="sr-only">{t('messageSearchNoMatches')}</span>
      )}
    </div>
  )
}
