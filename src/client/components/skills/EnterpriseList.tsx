import {
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  X,
} from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  EnterpriseIndustry,
  EnterprisePage,
} from '../../stores/enterprise-zone-store'
import { formatCount, industryLabels } from './enterprise-zone-utils'

interface EnterpriseListProps {
  page: EnterprisePage | null
  industries: EnterpriseIndustry[]
  keyword: string
  industry?: string
  requestedPage: number
  loading: boolean
  error: string | null
  industriesLoading: boolean
  industriesError: string | null
  onKeywordChange: (value: string) => void
  onIndustryChange: (value?: string) => void
  onPageChange: (page: number) => void
  onClearFilters: () => void
  onSelect: (orgId: string) => void
  onRetry: () => void
  onRetryIndustries: () => void
}

export default function EnterpriseList({
  page,
  industries,
  keyword,
  industry,
  requestedPage,
  loading,
  error,
  industriesLoading,
  industriesError,
  onKeywordChange,
  onIndustryChange,
  onPageChange,
  onClearFilters,
  onSelect,
  onRetry,
  onRetryIndustries,
}: EnterpriseListProps) {
  const { t, i18n } = useTranslation('settings')
  const language = i18n.resolvedLanguage ?? i18n.language
  const labelsByIndustry = useMemo(() => industryLabels(industries, language), [industries, language])
  const enterprises = page?.enterprises.slice(0, 20) ?? []
  const visiblePage = page?.page ?? requestedPage
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1
  const filtered = Boolean(keyword || industry)
  const initialLoading = loading && !page

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="rounded-2xl border border-border bg-surface px-4 py-4 shadow-sm md:px-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <input
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              placeholder={t('skills.enterpriseZone.searchEnterprises')}
              aria-label={t('skills.enterpriseZone.searchEnterprises')}
              className="h-10 w-full rounded-xl border border-border bg-bg pl-9 pr-9 text-xs text-text-primary outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            {keyword ? (
              <button
                type="button"
                onClick={() => onKeywordChange('')}
                aria-label={t('skills.enterpriseZone.clearEnterpriseSearch')}
                className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-text-tertiary hover:text-text-primary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <select
            value={industry ?? ''}
            onChange={(event) => onIndustryChange(event.target.value || undefined)}
            aria-label={t('skills.enterpriseZone.filterByIndustry')}
            disabled={industriesLoading}
            className="h-10 min-w-52 rounded-xl border border-border bg-bg px-3 text-xs text-text-secondary outline-none focus:border-accent disabled:opacity-60"
          >
            <option value="">{t('skills.enterpriseZone.allIndustries')}</option>
            {industries.map((item) => (
              <option key={item.key} value={item.key}>{labelsByIndustry.get(item.key)}</option>
            ))}
          </select>
          <p className="shrink-0 px-1 text-xs text-text-tertiary">
            {t('skills.enterpriseZone.enterpriseCount', { count: formatCount(page?.total ?? 0) })}
          </p>
        </div>

        {industriesError ? (
          <div
            role="status"
            aria-label={t('skills.enterpriseZone.industryFiltersUnavailable')}
            className="mt-3 flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:flex-row sm:items-center sm:justify-between dark:text-amber-300"
          >
            <span>{t('skills.enterpriseZone.industryErrorHint', { error: industriesError })}</span>
            <button type="button" onClick={onRetryIndustries} aria-label={t('skills.enterpriseZone.retryIndustryFilters')} className="font-medium underline underline-offset-2">
              {t('skills.enterpriseZone.retryFilters')}
            </button>
          </div>
        ) : null}
      </header>

      {initialLoading ? (
        <div aria-busy="true" aria-label={t('skills.enterpriseZone.loadingEnterprises')} className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-40 animate-pulse rounded-2xl border border-border bg-surface" />
          ))}
        </div>
      ) : error && !page ? (
        <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
          <p className="text-sm font-medium text-text-primary">{t('skills.enterpriseZone.catalogLoadFailed')}</p>
          <p className="mt-1 text-xs text-text-secondary">{error}</p>
          <button type="button" onClick={onRetry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-foreground">{t('skills.enterpriseZone.retryEnterprises')}</button>
        </section>
      ) : enterprises.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-border bg-surface/50 p-10 text-center">
          <Building2 className="mx-auto h-8 w-8 text-text-tertiary" />
          <p className="mt-3 text-sm font-medium text-text-secondary">
            {t(filtered ? 'skills.enterpriseZone.noEnterpriseMatches' : 'skills.enterpriseZone.noEnterprises')}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">
            {t(filtered ? 'skills.enterpriseZone.adjustEnterpriseFilters' : 'skills.enterpriseZone.enterpriseComeBack')}
          </p>
          {filtered ? (
            <button type="button" onClick={onClearFilters} aria-label={t('skills.enterpriseZone.clearEnterpriseFilters')} className="mt-4 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary hover:border-accent/40">
              {t('skills.enterpriseZone.clearFilters')}
            </button>
          ) : null}
        </section>
      ) : (
        <>
          {error ? (
            <div role="status" className="flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:flex-row sm:items-center sm:justify-between dark:text-amber-300">
              <span>{t('skills.enterpriseZone.showingLastPage', { error })}</span>
              <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">{t('skills.enterpriseZone.retryPage')}</button>
            </div>
          ) : null}
          {loading ? <p role="status" className="text-xs text-text-tertiary">{t('skills.enterpriseZone.refreshingEnterprises')}</p> : null}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-busy={loading}>
            {enterprises.map((item) => (
              <button
                key={item.orgId}
                type="button"
                data-enterprise-org={item.orgId}
                onClick={() => onSelect(item.orgId)}
                className="group w-full rounded-2xl border border-border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md motion-reduce:transform-none"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent/10 text-accent">
                    {item.logoUrl ? <img src={item.logoUrl} alt="" className="h-full w-full object-cover" /> : <Building2 className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate text-sm font-semibold text-text-primary">{item.name}</h3>
                      <CheckCircle2 aria-label={t('skills.enterpriseZone.verifiedEnterprise')} className="h-3.5 w-3.5 shrink-0 text-accent" />
                    </div>
                    {item.fullName && item.fullName !== item.name ? <p className="mt-0.5 truncate text-[10px] text-text-tertiary">{item.fullName}</p> : null}
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                </div>
                <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-text-secondary">{item.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.industryTags.map((tag) => <span key={tag} className="rounded-md bg-surface-hover px-2 py-1 text-[10px] text-text-tertiary">{labelsByIndustry.get(tag) ?? tag}</span>)}
                </div>
                <div className="mt-3 flex items-center gap-3 text-[10px] text-text-tertiary">
                  <span>{t('skills.enterpriseZone.skillCount', { count: formatCount(item.publishedSkillCount) })}</span>
                  <span className="inline-flex items-center gap-1"><Download className="h-3 w-3" /> {formatCount(item.totalDownloads)}</span>
                </div>
              </button>
            ))}
          </div>
          <nav className="flex items-center justify-center gap-3 pt-1" aria-label={t('skills.enterpriseZone.enterprisePagination')}>
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, visiblePage - 1))}
              disabled={visiblePage <= 1 || loading}
              aria-label={t('skills.enterpriseZone.previousEnterprisePage')}
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs text-text-secondary disabled:opacity-50"
            ><ChevronLeft className="h-3.5 w-3.5" /> {t('skills.enterpriseZone.previous')}</button>
            <span className="min-w-24 text-center text-xs text-text-tertiary">{t('skills.enterpriseZone.pageOf', { page: visiblePage, totalPages })}</span>
            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, visiblePage + 1))}
              disabled={visiblePage >= totalPages || loading}
              aria-label={t('skills.enterpriseZone.nextEnterprisePage')}
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs text-text-secondary disabled:opacity-50"
            >{t('skills.enterpriseZone.next')} <ChevronRight className="h-3.5 w-3.5" /></button>
          </nav>
        </>
      )}
    </div>
  )
}
