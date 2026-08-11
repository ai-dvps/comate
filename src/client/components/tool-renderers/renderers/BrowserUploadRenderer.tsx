import type { ReactNode } from 'react'
import { FileUp, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BROWSER_TOOL_NAMES } from '@server/services/browser-tool-names'
import { registerToolRenderer } from '../registry'
import { parseBrowserUploadInput, type BrowserUploadPayload } from './browser-upload-payload'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BrowserUploadManifest({ payload }: { payload: BrowserUploadPayload }) {
  const { t } = useTranslation('chat')
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{payload.warning}</span>
      </div>
      <div className="flex items-start gap-2"><span className="text-text-tertiary text-xs">{t('approval.browserUpload.origin')}</span><span className="text-text-primary break-all">{payload.origin}</span></div>
      <ul className="space-y-1.5">
        {payload.files.map((file, index) => (
          <li key={`${file.name}-${index}`} className="flex items-center gap-2 rounded border border-border/50 px-2.5 py-2">
            <FileUp className="w-4 h-4 text-accent shrink-0" />
            <span className="min-w-0 flex-1 break-all text-text-primary">{file.name}</span>
            <span className="text-xs text-text-tertiary shrink-0">{file.mediaType}</span>
            <span className="text-xs tabular-nums text-text-secondary shrink-0">{formatBytes(file.size)}</span>
          </li>
        ))}
      </ul>
      <div className="text-xs text-text-secondary">
        {t('approval.browserUpload.total', { count: payload.files.length, size: formatBytes(payload.totalBytes) })}
      </div>
      {payload.target?.accept?.text ? (
        <div className="text-[10px] text-text-tertiary">{t('approval.browserUpload.pageAccept')}: {payload.target.accept.text}</div>
      ) : null}
    </div>
  )
}

function BrowserUploadRenderer(input: unknown): ReactNode | null {
  const payload = parseBrowserUploadInput(input)
  return payload ? <BrowserUploadManifest payload={payload} /> : null
}

registerToolRenderer(BROWSER_TOOL_NAMES.upload, BrowserUploadRenderer, { securityManifest: true })
