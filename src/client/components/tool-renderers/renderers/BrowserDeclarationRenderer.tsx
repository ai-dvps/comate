import type { ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BROWSER_TOOL_NAMES } from '@server/services/browser-tool-names'
import { registerToolRenderer } from '../registry'
import { parseBrowserDeclarationInput, type BrowserDeclarationPayload } from './browser-declaration-payload'

export function BrowserDeclarationManifest({ payload }: { payload: BrowserDeclarationPayload }) {
  const { t } = useTranslation('chat')
  return (
    <div className="space-y-3 text-sm">
      <div role="note" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div><div className="font-semibold">{t('approval.browserDeclaration.warning')}</div><div>{t('approval.browserDeclaration.exactAction', { state: payload.intendedState ? t('approval.browserDeclaration.checked') : t('approval.browserDeclaration.unchecked') })}</div></div>
      </div>
      <section aria-label={t('approval.browserDeclaration.userIntent')} className="rounded border border-border/50 px-3 py-2 text-xs text-text-secondary">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-text-tertiary">{t('approval.browserDeclaration.userIntent')}</div>
        <div>{payload.origin}</div>
        <div>{t('approval.browserDeclaration.summary', payload.taskSummary)}</div>
      </section>
      <section aria-label={t('approval.browserDeclaration.untrustedPageText')} className="rounded border border-border/50 px-3 py-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-amber-300">{t('approval.browserDeclaration.untrustedPageText')}</div>
        <div dir="auto" className="break-words text-text-primary [unicode-bidi:plaintext]">{payload.declaration.text || t('approval.browserDeclaration.labelUnavailable')}</div>
      </section>
    </div>
  )
}

function BrowserDeclarationRenderer(input: unknown): ReactNode | null {
  const payload = parseBrowserDeclarationInput(input)
  return payload ? <BrowserDeclarationManifest payload={payload} /> : null
}

registerToolRenderer(BROWSER_TOOL_NAMES.setDeclaration, BrowserDeclarationRenderer, { securityManifest: true })
