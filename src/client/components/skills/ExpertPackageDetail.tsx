import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Boxes, CheckCircle2, ChevronRight, Download, Globe2, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { ExpertPackageDetail as ExpertPackageDetailData } from '../../stores/expert-packages-store'
import MarkdownPreview from '../MarkdownPreview'
import { stripSkillFrontmatter } from './expert-package-utils'

interface ExpertPackageDetailProps {
  detail?: ExpertPackageDetailData
  loading: boolean
  error?: string
  onBack: () => void
  onRetry: () => void
  onSelectSkill: (namespace: string, slug: string) => void
  onInstall: () => void
}

export default function ExpertPackageDetail({
  detail, loading, error, onBack, onRetry, onSelectSkill, onInstall,
}: ExpertPackageDetailProps) {
  const { t } = useTranslation('settings')
  const [tab, setTab] = useState<'overview' | 'skills'>('overview')

  if (loading && !detail) {
    return <div className="mx-auto h-80 max-w-5xl animate-pulse rounded-2xl border border-border bg-surface" />
  }
  if (error && !detail) {
    return (
      <div className="mx-auto max-w-5xl rounded-2xl border border-destructive/30 bg-surface p-8 text-center">
        <p className="text-sm font-medium text-text-primary">{t('skills.expertPackages.loadFailed')}</p>
        <p className="mt-1 text-xs text-text-secondary">{error}</p>
        <div className="mt-4 flex justify-center gap-2">
          <button onClick={onBack} className="rounded-lg border border-border px-3 py-2 text-xs text-text-secondary">{t('skills.expertPackages.back')}</button>
          <button onClick={onRetry} className="rounded-lg bg-accent px-3 py-2 text-xs text-accent-foreground">{t('skills.expertPackages.retry')}</button>
        </div>
      </div>
    )
  }
  if (!detail) return null
  const reportedSkills = detail.children.filter((child) => (child.securityReports?.length ?? 0) > 0).length

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex items-center gap-1.5 text-xs text-text-tertiary" aria-label={t('skills.expertPackages.breadcrumb')}>
        <button onClick={onBack} className="inline-flex items-center gap-1 hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" /> {t('skills.expertPackages.back')}
        </button>
        <span>/</span>
        <span className="truncate text-text-secondary">{detail.displayName}</span>
      </nav>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="p-5 md:p-6">
          <div className="flex flex-col gap-5 md:flex-row md:items-start">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Boxes className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-text-primary">{detail.displayName}</h2>
                <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent">{t('skills.expertPackages.expert', { scene: detail.subScene || detail.scene })}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-1 text-[10px] text-text-secondary"><Globe2 className="h-3 w-3" /> {t('skills.expertPackages.sourceVerified')}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-600 dark:text-emerald-400"><ShieldCheck className="h-3 w-3" /> {t('skills.expertPackages.securityCoverage', { reported: reportedSkills, total: detail.children.length })}</span>
              </div>
              <p className="mt-2 max-w-3xl text-xs leading-5 text-text-secondary">{detail.summary}</p>
              <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-text-tertiary">
                <span>{t('skills.expertPackages.standardSkillCount', { count: detail.skillCount })}</span><span>·</span><span>SkillHub</span><span>·</span><span>{detail.scene}</span>
              </div>
            </div>
            <button
              onClick={onInstall}
              disabled={!detail.complete}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 text-xs font-medium text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" /> {t('skills.expertPackages.installPackage')}
            </button>
          </div>
          {!detail.complete && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('skills.expertPackages.unavailable', { reason: detail.unavailableReason || t('skills.expertPackages.unavailableFallback') })}</span>
            </div>
          )}
        </div>
        <div className="flex gap-1 border-t border-border px-5 pt-2" role="tablist">
          <button role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')} className={`border-b-2 px-3 py-2.5 text-xs font-medium ${tab === 'overview' ? 'border-accent text-accent' : 'border-transparent text-text-tertiary'}`}>{t('skills.expertPackages.overview')}</button>
          <button role="tab" aria-selected={tab === 'skills'} onClick={() => setTab('skills')} className={`border-b-2 px-3 py-2.5 text-xs font-medium ${tab === 'skills' ? 'border-accent text-accent' : 'border-transparent text-text-tertiary'}`}>{t('skills.expertPackages.includedSkills', { count: detail.children.length })}</button>
        </div>
      </section>

      {tab === 'overview' ? (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="border-b border-border px-5 py-3 text-xs font-semibold text-text-primary">{t('skills.expertPackages.orchestrationWorkflow')}</div>
          <MarkdownPreview content={stripSkillFrontmatter(detail.content)} className="px-5 py-4 text-xs" />
        </section>
      ) : (
        <section className="space-y-2">
          {detail.children.map((skill, index) => (
            <button
              key={`${skill.namespace}/${skill.slug}`}
              onClick={() => { if (skill.available) onSelectSkill(skill.namespace, skill.slug) }}
              disabled={!skill.available}
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3.5 text-left shadow-sm transition hover:border-accent/35 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-xs font-semibold text-text-secondary">{index + 1}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-medium text-text-primary">{skill.displayName}</h3>
                  {skill.available ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <span className="text-[10px] text-amber-500">{t('skills.expertPackages.temporarilyUnavailable')}</span>}
                  {(skill.securityReports?.length ?? 0) > 0 && <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"><ShieldCheck className="h-3 w-3" /> {t('skills.expertPackages.securityReportCount', { count: skill.securityReports?.length })}</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{skill.summary || `${skill.namespace}/${skill.slug}`}</p>
              </div>
              {skill.available && <ChevronRight className="h-4 w-4 text-text-tertiary" />}
            </button>
          ))}
        </section>
      )}
    </div>
  )
}
