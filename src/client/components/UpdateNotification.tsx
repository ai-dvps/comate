import { useTranslation } from 'react-i18next'
import { Download, X, Loader2 } from 'lucide-react'
import { useUpdaterStore } from '../stores/updater-store'
import { downloadAndInstallUpdate, dismissUpdate } from '../lib/updater-api'

export default function UpdateNotification() {
  const { t } = useTranslation('common')
  const { status, update, downloadProgress, error } = useUpdaterStore()

  const visible = status === 'available' || status === 'downloading' || status === 'checking'
  if (!visible) return null

  const isChecking = status === 'checking'
  const isDownloading = status === 'downloading'

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-2 left-1/2 -translate-x-1/2 z-40 bg-surface border border-border rounded-lg shadow-lg px-4 py-2.5 flex items-center gap-3 max-w-md"
    >
      {isChecking ? (
        <Loader2 className="w-4 h-4 text-text-secondary animate-spin flex-shrink-0" aria-hidden="true" />
      ) : (
        <Download className="w-4 h-4 text-accent flex-shrink-0" aria-hidden="true" />
      )}

      <div className="flex flex-col min-w-0">
        <span className="text-xs font-medium text-text-primary">
          {isChecking
            ? t('update.checking')
            : isDownloading
              ? t('update.downloading', { progress: downloadProgress })
              : t('update.available', { version: update?.version ?? '' })}
        </span>
        {error && (
          <span className="text-xs text-destructive truncate">{error}</span>
        )}
        {isDownloading && (
          <div
            className="w-full h-1 bg-border rounded-full mt-1.5 overflow-hidden"
            role="progressbar"
            aria-valuenow={downloadProgress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-accent transition-all duration-200"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        {!isChecking && !isDownloading && (
          <button
            onClick={() => void downloadAndInstallUpdate()}
            className="px-2.5 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-md transition-colors"
          >
            {t('update.download')}
          </button>
        )}
        {!isDownloading && (
          <button
            onClick={dismissUpdate}
            className="p-1 rounded text-text-tertiary hover:text-text-primary transition-colors"
            aria-label={t('close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
