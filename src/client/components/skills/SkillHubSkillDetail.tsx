import { CheckCircle2, Download, ExternalLink, ShieldCheck, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openUrlInBrowser } from '../../lib/open-url'
import type { SkillHubSkillDetail as SkillHubSkillDetailData } from '../../types/skillhub'
import MarkdownPreview from '../MarkdownPreview'
import { stripSkillFrontmatter } from './expert-package-utils'

interface SkillHubSkillDetailProps {
  detail?: SkillHubSkillDetailData | null
  loading: boolean
  error?: string | null
  errorTitle: string
  retryLabel: string
  contextLabel?: string
  installed?: boolean
  onRetry: () => void
  onInstall: () => void
}

export default function SkillHubSkillDetail({
  detail,
  loading,
  error,
  errorTitle,
  retryLabel,
  contextLabel,
  installed = false,
  onRetry,
  onInstall,
}: SkillHubSkillDetailProps) {
  const { t } = useTranslation('settings')

  if (loading && !detail) return (
    <div aria-busy="true" className="animate-pulse space-y-4">
      <section className="rounded-2xl border border-border bg-surface p-5 md:p-6">
        <div className="flex gap-5">
          <div className="h-12 w-12 shrink-0 rounded-xl bg-surface-hover" />
          <div className="min-w-0 flex-1 space-y-3 pt-1">
            <div className="h-5 w-2/5 rounded bg-surface-hover" />
            <div className="h-3 w-1/4 rounded bg-surface-hover" />
            <div className="h-3 w-full max-w-3xl rounded bg-surface-hover" />
          </div>
        </div>
      </section>
      <section className="h-40 rounded-2xl border border-border bg-white" />
    </div>
  )

  if (error && !detail) return (
    <div className="rounded-2xl border border-destructive/30 bg-surface p-8 text-center">
      <p className="text-sm font-medium text-text-primary">{errorTitle}</p>
      <p className="mt-1 text-xs text-text-secondary">{error}</p>
      <button type="button" onClick={onRetry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs text-accent-foreground">{retryLabel}</button>
    </div>
  )

  if (!detail) return null

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><UserRound className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold text-text-primary">{detail.displayName}</h2>
            {contextLabel ? <p className="mt-1 text-[11px] font-medium text-accent">{contextLabel}</p> : null}
            <p className="mt-1 text-[11px] text-text-tertiary">{detail.owner.displayName} · @{detail.owner.handle}</p>
            {detail.publisher ? <p className="mt-1 text-[11px] text-text-tertiary">{t('skills.skillHubDetail.publisher', { publisher: detail.publisher.orgId })}</p> : null}
            <p className="mt-3 max-w-3xl text-xs leading-5 text-text-secondary">{detail.summary}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-text-tertiary">
              <span className="rounded-md bg-surface-hover px-2 py-1">{detail.category || t('skills.expertPackages.uncategorized')}</span>
              <span className="rounded-md bg-surface-hover px-2 py-1">v{detail.version || t('skills.expertPackages.latest')}</span>
              <span className="rounded-md bg-surface-hover px-2 py-1">{t('skills.expertPackages.downloads', { count: detail.stats.downloads.toLocaleString() })}</span>
              <span className="rounded-md bg-surface-hover px-2 py-1">{t('skills.expertPackages.installs', { count: detail.stats.installs.toLocaleString() })}</span>
            </div>
          </div>
          <button type="button" onClick={onInstall} disabled={installed} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[11px] font-medium disabled:cursor-not-allowed ${installed ? 'bg-surface-hover text-text-secondary' : 'bg-accent text-accent-foreground hover:bg-accent-hover'}`}>
            {installed ? <CheckCircle2 className="h-3 w-3" /> : <Download className="h-3 w-3" />}
            {t(installed ? 'skills.expertPackages.installed' : 'skills.expertPackages.installSkill')}
          </button>
        </div>
        {error ? (
          <div role="status" className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <span>{t('skills.skillHubDetail.showingLastDetail', { error })}</span>
            <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">{retryLabel}</button>
          </div>
        ) : null}
      </section>

      {detail.securityReports.length > 0 ? (
        <section className="rounded-2xl border border-border bg-white p-4 shadow-sm">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary"><ShieldCheck className="h-4 w-4 text-emerald-500" /> {t('skills.expertPackages.securityReports')}</h3>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {detail.securityReports.map((report) => (
              <button
                type="button"
                key={report.provider}
                onClick={() => { if (report.reportUrl) void openUrlInBrowser(report.reportUrl) }}
                disabled={!report.reportUrl}
                className="flex items-center justify-between rounded-xl border border-border bg-white p-3 text-left disabled:cursor-default"
              >
                <span><span className="block text-xs font-medium text-text-primary">{report.provider}</span><span className="mt-0.5 block text-[10px] text-text-tertiary">{report.statusText || report.status}</span></span>
                {report.reportUrl ? <ExternalLink className="h-3.5 w-3.5 text-text-tertiary" /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        <div className="border-b border-border px-5 py-3 text-xs font-semibold text-text-primary">{t('skills.expertPackages.documentation')}</div>
        {detail.documentation
          ? <MarkdownPreview content={stripSkillFrontmatter(detail.documentation)} className="px-5 py-4 text-xs" />
          : <div className="p-6 text-xs text-text-tertiary">{t('skills.expertPackages.noDocumentation')}</div>}
      </section>
    </div>
  )
}
