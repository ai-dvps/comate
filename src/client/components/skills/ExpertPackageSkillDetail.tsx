import { ArrowLeft, CheckCircle2, Download, ExternalLink, ShieldCheck, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ExpertSkillDetail } from '../../stores/expert-packages-store'
import { openUrlInBrowser } from '../../lib/open-url'
import MarkdownPreview from '../MarkdownPreview'
import { stripSkillFrontmatter } from './expert-package-utils'

interface ExpertPackageSkillDetailProps {
  packageName: string
  detail?: ExpertSkillDetail
  loading: boolean
  error?: string
  installed?: boolean
  onBack: () => void
  onBackToList: () => void
  onRetry: () => void
  onInstall: () => void
}

export default function ExpertPackageSkillDetail({
  packageName, detail, loading, error, installed = false, onBack, onBackToList, onRetry, onInstall,
}: ExpertPackageSkillDetailProps) {
  const { t } = useTranslation('settings')
  if (loading) return (
    <div aria-busy="true" className="mx-auto max-w-5xl animate-pulse space-y-4">
      <div className="h-3 w-56 rounded bg-surface-hover" />
      <section className="rounded-2xl border border-border bg-surface p-5 md:p-6">
        <div className="h-3 w-32 rounded bg-surface-hover" />
        <div className="mt-5 flex gap-5">
          <div className="h-12 w-12 shrink-0 rounded-xl bg-surface-hover" />
          <div className="min-w-0 flex-1 space-y-3 pt-1">
            <div className="h-5 w-2/5 rounded bg-surface-hover" />
            <div className="h-3 w-1/4 rounded bg-surface-hover" />
            <div className="h-3 w-full max-w-3xl rounded bg-surface-hover" />
          </div>
        </div>
      </section>
      <section className="rounded-2xl border border-border bg-white p-5">
        <div className="h-3 w-32 rounded bg-surface-hover" />
        <div className="mt-5 space-y-3">
          <div className="h-3 w-full rounded bg-surface-hover" />
          <div className="h-3 w-4/5 rounded bg-surface-hover" />
          <div className="h-3 w-3/5 rounded bg-surface-hover" />
        </div>
      </section>
    </div>
  )
  if (error && !detail) return (
    <div className="mx-auto max-w-5xl rounded-2xl border border-destructive/30 bg-surface p-8 text-center">
      <p className="text-sm font-medium text-text-primary">{t('skills.expertPackages.skillDetailFailed')}</p>
      <p className="mt-1 text-xs text-text-secondary">{error}</p>
      <button onClick={onRetry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs text-accent-foreground">{t('skills.expertPackages.retry')}</button>
    </div>
  )
  if (!detail) return null

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <button onClick={onBackToList} className="hover:text-text-primary">{t('skills.expertPackages.back')}</button><span>/</span>
        <button onClick={onBack} className="hover:text-text-primary">{packageName}</button><span>/</span>
        <span className="truncate text-text-secondary">{detail.displayName}</span>
      </nav>
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm md:p-6">
        <button onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary"><ArrowLeft className="h-3.5 w-3.5" /> {t('skills.expertPackages.backToPackage')}</button>
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><UserRound className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold text-text-primary">{detail.displayName}</h2>
            <p className="mt-1 text-[11px] text-text-tertiary">{detail.owner.displayName} · @{detail.owner.handle}</p>
            <p className="mt-3 max-w-3xl text-xs leading-5 text-text-secondary">{detail.summary}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-text-tertiary">
              <span className="rounded-md bg-surface-hover px-2 py-1">{detail.category || t('skills.expertPackages.uncategorized')}</span>
              <span className="rounded-md bg-surface-hover px-2 py-1">v{detail.version || t('skills.expertPackages.latest')}</span>
              <span className="rounded-md bg-surface-hover px-2 py-1">{t('skills.expertPackages.downloads', { count: detail.stats.downloads.toLocaleString() })}</span>
              <span className="rounded-md bg-surface-hover px-2 py-1">{t('skills.expertPackages.installs', { count: detail.stats.installs.toLocaleString() })}</span>
            </div>
          </div>
          <button onClick={onInstall} disabled={installed} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[11px] font-medium disabled:cursor-not-allowed ${installed ? 'bg-surface-hover text-text-secondary' : 'bg-accent text-accent-foreground hover:bg-accent-hover'}`}>
            {installed ? <CheckCircle2 className="h-3 w-3" /> : <Download className="h-3 w-3" />}
            {t(installed ? 'skills.expertPackages.installed' : 'skills.expertPackages.installSkill')}
          </button>
        </div>
      </section>

      {detail.securityReports.length > 0 && (
        <section className="rounded-2xl border border-border bg-white p-4 shadow-sm">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary"><ShieldCheck className="h-4 w-4 text-emerald-500" /> {t('skills.expertPackages.securityReports')}</h3>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {detail.securityReports.map((report) => (
              <button
                key={report.provider}
                onClick={() => { if (report.reportUrl) void openUrlInBrowser(report.reportUrl) }}
                disabled={!report.reportUrl}
                className="flex items-center justify-between rounded-xl border border-border bg-white p-3 text-left disabled:cursor-default"
              >
                <span><span className="block text-xs font-medium text-text-primary">{report.provider}</span><span className="mt-0.5 block text-[10px] text-text-tertiary">{report.statusText || report.status}</span></span>
                {report.reportUrl && <ExternalLink className="h-3.5 w-3.5 text-text-tertiary" />}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        <div className="border-b border-border px-5 py-3 text-xs font-semibold text-text-primary">{t('skills.expertPackages.documentation')}</div>
        {detail.documentation
          ? <MarkdownPreview content={stripSkillFrontmatter(detail.documentation)} className="px-5 py-4 text-xs" />
          : <div className="p-6 text-xs text-text-tertiary">{t('skills.expertPackages.noDocumentation')}</div>}
      </section>
    </div>
  )
}
