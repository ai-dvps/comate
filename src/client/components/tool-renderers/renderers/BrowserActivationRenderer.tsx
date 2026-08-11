import type { ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BROWSER_TOOL_NAMES } from '@server/services/browser-tool-names'
import { registerToolRenderer } from '../registry'
import { parseBrowserActivationInput, type BrowserActivationPayload } from './browser-activation-payload'

export function BrowserActivationManifest({ payload }: { payload: BrowserActivationPayload }) {
  const { t } = useTranslation('chat')
  const summary = payload.editorSummary
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{payload.reconfirmation ? t('approval.browserActivation.reconfirmation') : payload.warning}</span>
      </div>
      <ManifestRow label={t('approval.browserActivation.origin')} value={payload.origin} />
      <div className="rounded border border-border/50 px-3 py-2 space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-amber-300">
          {t('approval.browserActivation.untrustedPageContext')}
        </div>
        <ManifestRow label={t('approval.browserActivation.role')} value={payload.target.role?.text || '—'} />
        <ManifestRow label={t('approval.browserActivation.name')} value={payload.target.name?.text || '—'} />
        {payload.target.nearbyContext?.text ? <ManifestRow label={t('approval.browserActivation.nearby')} value={payload.target.nearbyContext.text} /> : null}
      </div>
      {summary ? (
        <div className="text-xs text-text-secondary">
          {t('approval.browserActivation.editorSummary', {
            count: summary.editorCount ?? 0,
            filled: summary.filledEditorCount ?? 0,
            length: summary.totalEditorLength ?? 0,
          })}
        </div>
      ) : null}
      {payload.differences?.length ? (
        <ul className="list-disc pl-5 text-xs text-text-secondary">
          {payload.differences.map((difference) => <li key={difference}>{difference}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

function ManifestRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start gap-2"><span className="text-text-tertiary text-xs shrink-0">{label}</span><span className="text-text-primary break-all">{value}</span></div>
}

function BrowserActivationRenderer(input: unknown): ReactNode | null {
  const payload = parseBrowserActivationInput(input)
  return payload ? <BrowserActivationManifest payload={payload} /> : null
}

registerToolRenderer(BROWSER_TOOL_NAMES.activate, BrowserActivationRenderer, { securityManifest: true })
