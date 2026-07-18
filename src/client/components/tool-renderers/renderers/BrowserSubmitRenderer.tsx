import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { registerToolRenderer } from '../registry'
import {
  parseBrowserSubmitInput,
  type BrowserSubmitPayload,
} from './browser-submit-payload'

/**
 * Renderer for the embedded browser's submit confirmation payload (U4,
 * KTD-4 ②). Renders the destination + field manifest on the approval card;
 * sensitive fields show name only (values are absent from the payload by
 * construction — see browser-submit-payload.ts).
 */

const DIFF_KINDS = ['action_changed', 'method_changed', 'value_changed', 'field_added', 'field_removed'] as const

export function BrowserSubmitManifest({ payload }: { payload: BrowserSubmitPayload }) {
  const { t } = useTranslation('chat')
  const fields = Array.isArray(payload.fields) ? payload.fields : []
  const differences = Array.isArray(payload.differences) ? payload.differences : []

  return (
    <div className="space-y-2 text-sm">
      {payload.reconfirmation && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{t('approval.browserSubmit.reconfirmation')}</span>
        </div>
      )}

      <div className="flex items-start gap-2">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0 pt-0.5">
          {t('approval.browserSubmit.destination')}
        </span>
        <span className="min-w-0">
          {payload.method && (
            <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent/15 text-accent align-middle">
              {payload.method}
            </span>
          )}
          <span className="text-text-primary break-all">{payload.action || payload.actionOrigin || '—'}</span>
        </span>
      </div>

      {payload.pageUrl && (
        <div className="flex items-start gap-2">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0 pt-0.5">
            {t('approval.browserSubmit.page')}
          </span>
          <span className="text-text-secondary break-all">{payload.pageUrl}</span>
        </div>
      )}

      {payload.formName && (
        <div className="flex items-start gap-2">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0 pt-0.5">
            {t('approval.browserSubmit.form')}
          </span>
          <span className="text-text-secondary">{payload.formName}</span>
        </div>
      )}

      <div>
        <div className="text-text-tertiary text-xs uppercase tracking-wide mb-1">
          {t('approval.browserSubmit.fields', { count: fields.length })}
        </div>
        {fields.length === 0 ? (
          <div className="text-text-tertiary text-xs">{t('approval.browserSubmit.emptyFields')}</div>
        ) : (
          <ul className="space-y-1">
            {fields.map((field, index) => (
              <li
                key={`${field.name}-${index}`}
                className="flex items-baseline gap-2 bg-bg rounded px-2 py-1"
              >
                <span className="text-text-primary font-medium break-all">{field.name}</span>
                <span className="text-text-tertiary text-xs shrink-0">{field.type}</span>
                {field.sensitive ? (
                  <span className="text-amber-400/90 text-xs italic">
                    {t('approval.browserSubmit.sensitiveValue')}
                  </span>
                ) : (
                  field.value !== undefined &&
                  field.value !== '' && (
                    <span className="text-text-secondary text-xs font-mono break-all">
                      {field.value}
                    </span>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {differences.length > 0 && (
        <div>
          <div className="text-text-tertiary text-xs uppercase tracking-wide mb-1">
            {t('approval.browserSubmit.differences')}
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-xs text-text-secondary">
            {differences.map((diff, index) => (
              <li key={`${diff.kind}-${diff.field ?? ''}-${index}`}>
                {DIFF_KINDS.includes(diff.kind as (typeof DIFF_KINDS)[number])
                  ? t(`approval.browserSubmit.diff.${diff.kind}`, { field: diff.field ?? '' })
                  : diff.kind}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function BrowserSubmitRenderer(input: unknown): ReactNode | null {
  const payload = parseBrowserSubmitInput(input)
  if (!payload) return null
  return <BrowserSubmitManifest payload={payload} />
}

registerToolRenderer('mcp__comate-browser__submit', BrowserSubmitRenderer)
