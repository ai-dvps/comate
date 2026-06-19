import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { useUpdaterStore } from '../stores/updater-store'
import { restartToUpdate, dismissUpdate } from '../lib/updater-api'

interface UpdateRestartDialogProps {
  onForceShowWindow?: () => void
}

export default function UpdateRestartDialog({ onForceShowWindow }: UpdateRestartDialogProps) {
  const { t } = useTranslation('common')
  const { status, update } = useUpdaterStore()

  useEffect(() => {
    if (status === 'ready') {
      onForceShowWindow?.()
    }
  }, [status, onForceShowWindow])

  if (status !== 'ready') return null

  const handleRestart = () => {
    void restartToUpdate()
  }

  const handleLater = () => {
    dismissUpdate()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16">
      <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={handleLater} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-restart-title"
        className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md flex flex-col"
      >
        <div className="px-5 py-4 border-b border-border/50 flex-shrink-0">
          <h2 id="update-restart-title" className="text-sm font-medium text-text-primary">
            {t('update.restartTitle')}
          </h2>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs text-text-secondary">
            {t('update.restartMessage', { version: update?.version ?? '' })}
          </p>
          {update?.body && (
            <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-bg border border-border p-3">
              <p className="text-xs text-text-secondary whitespace-pre-wrap">{update.body}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50 flex-shrink-0">
          <button
            onClick={handleLater}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
          >
            {t('update.restartLater')}
          </button>
          <button
            onClick={handleRestart}
            className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
          >
            {t('update.restartNow')}
          </button>
        </div>
      </div>
    </div>
  )
}
