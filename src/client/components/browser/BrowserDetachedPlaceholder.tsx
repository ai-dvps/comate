import { ExternalLink, PanelRightClose, PanelsTopLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../ui/utils'
import { FOCUS_CLASSES } from './focus-classes'

interface BrowserDetachedPlaceholderProps {
  title: string
  onFocus: () => void
  onRestore: () => void
}

export default function BrowserDetachedPlaceholder({
  title,
  onFocus,
  onRestore,
}: BrowserDetachedPlaceholderProps) {
  const { t } = useTranslation('browser')
  return (
    <section
      data-testid="browser-detached-placeholder"
      aria-live="polite"
      className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center bg-bg"
    >
      <div className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center">
        <PanelsTopLeft className="w-5 h-5" aria-hidden="true" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="text-sm font-medium text-text-primary">{t('pane.detachedTitle')}</p>
        <p className="text-xs text-text-secondary">{t('pane.detachedDetail', { title })}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          data-testid="browser-detached-focus"
          onClick={onFocus}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
            'border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover',
            FOCUS_CLASSES,
          )}
        >
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          {t('action.focusWindow')}
        </button>
        <button
          type="button"
          data-testid="browser-detached-restore"
          onClick={onRestore}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
            'bg-accent text-white hover:bg-accent/90',
            FOCUS_CLASSES,
          )}
        >
          <PanelRightClose className="w-3.5 h-3.5" aria-hidden="true" />
          {t('action.restoreToPanel')}
        </button>
      </div>
    </section>
  )
}
