import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Star,
  X,
} from 'lucide-react'
import type {
  EnterpriseDetail as EnterpriseDetailData,
  EnterpriseIndustry,
  EnterpriseSkillPage,
  EnterpriseSkillSort,
} from '../../stores/enterprise-zone-store'

interface EnterpriseDetailProps {
  detail: EnterpriseDetailData | null
  industries: EnterpriseIndustry[]
  detailLoading: boolean
  detailError: string | null
  skillPage: EnterpriseSkillPage | null
  skillKeyword: string
  skillSort: EnterpriseSkillSort
  requestedSkillPage: number
  skillsLoading: boolean
  skillsError: string | null
  onBack: () => void
  onRetryDetail: () => void
  onRetrySkills: () => void
  onSkillKeywordChange: (value: string) => void
  onSkillSortChange: (value: EnterpriseSkillSort) => void
  onSkillPageChange: (page: number) => void
  onSelectSkill: (namespace: string, slug: string) => void
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

function industryLabel(industries: EnterpriseIndustry[], key: string): string {
  return industries.find((industry) => industry.key === key)?.displayName ?? key
}

export default function EnterpriseDetail({
  detail,
  industries,
  detailLoading,
  detailError,
  skillPage,
  skillKeyword,
  skillSort,
  requestedSkillPage,
  skillsLoading,
  skillsError,
  onBack,
  onRetryDetail,
  onRetrySkills,
  onSkillKeywordChange,
  onSkillSortChange,
  onSkillPageChange,
  onSelectSkill,
}: EnterpriseDetailProps) {
  if (detailLoading && !detail) {
    return (
      <div aria-busy="true" aria-label="Loading enterprise profile" className="mx-auto max-w-5xl animate-pulse space-y-4">
        <div className="h-3 w-40 rounded bg-surface-hover" />
        <div className="h-40 rounded-2xl border border-border bg-surface" />
        <div className="h-72 rounded-2xl border border-border bg-surface" />
      </div>
    )
  }

  if (detailError && !detail) {
    return (
      <section className="mx-auto max-w-5xl rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
        <p className="text-sm font-medium text-text-primary">Enterprise profile could not be loaded.</p>
        <p className="mt-1 text-xs text-text-secondary">{detailError}</p>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={onBack} aria-label="Back to enterprises" className="rounded-lg border border-border px-3 py-2 text-xs text-text-secondary">Back</button>
          <button type="button" onClick={onRetryDetail} className="rounded-lg bg-accent px-3 py-2 text-xs text-accent-foreground">Retry profile</button>
        </div>
      </section>
    )
  }

  if (!detail) return null

  const skills = skillPage?.skills.slice(0, 20) ?? []
  const visiblePage = skillPage?.page ?? requestedSkillPage
  const totalPages = skillPage ? Math.max(1, Math.ceil(skillPage.total / skillPage.pageSize)) : 1
  const initialSkillsLoading = skillsLoading && !skillPage
  const filtered = Boolean(skillKeyword)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex items-center gap-1.5 text-xs text-text-tertiary" aria-label="Enterprise breadcrumb">
        <button type="button" onClick={onBack} aria-label="Back to enterprises" className="inline-flex items-center gap-1 hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" /> Enterprises
        </button>
        <span>/</span>
        <span className="truncate text-text-secondary">{detail.name}</span>
      </nav>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-accent/10 text-accent">
            {detail.logoUrl ? <img src={detail.logoUrl} alt="" className="h-full w-full object-cover" /> : <Building2 className="h-6 w-6" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-text-primary">{detail.name}</h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent"><CheckCircle2 className="h-3 w-3" /> Verified enterprise</span>
            </div>
            {detail.fullName && detail.fullName !== detail.name ? <p className="mt-1 text-xs text-text-tertiary">{detail.fullName}</p> : null}
            <p className="mt-2 max-w-3xl text-xs leading-5 text-text-secondary">{detail.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {detail.industryTags.map((tag) => <span key={tag} className="rounded-md bg-surface-hover px-2 py-1 text-[10px] text-text-tertiary">{industryLabel(industries, tag)}</span>)}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-text-tertiary">
              <span>{formatCount(detail.publishedSkillCount)} published Skills</span>
              <span className="inline-flex items-center gap-1"><Download className="h-3 w-3" /> {formatCount(detail.totalDownloads)} downloads</span>
              <span className="inline-flex items-center gap-1"><Star className="h-3 w-3" /> {formatCount(detail.totalStars)} stars</span>
            </div>
          </div>
        </div>
        {detailError ? (
          <div role="status" className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <span>{detailError}. Showing the last available profile.</span>
            <button type="button" onClick={onRetryDetail} className="font-medium underline underline-offset-2">Retry profile</button>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
              <input
                value={skillKeyword}
                onChange={(event) => onSkillKeywordChange(event.target.value)}
                placeholder="Search Enterprise Skills"
                aria-label="Search Enterprise Skills"
                className="h-10 w-full rounded-xl border border-border bg-bg pl-9 pr-9 text-xs text-text-primary outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              {skillKeyword ? (
                <button type="button" onClick={() => onSkillKeywordChange('')} aria-label="Clear Skill search" className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-text-tertiary hover:text-text-primary">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <select
              value={skillSort}
              onChange={(event) => onSkillSortChange(event.target.value as EnterpriseSkillSort)}
              aria-label="Sort Enterprise Skills"
              className="h-10 min-w-48 rounded-xl border border-border bg-bg px-3 text-xs text-text-secondary outline-none focus:border-accent"
            >
              <option value="downloads">Most downloaded</option>
              <option value="stars">Most starred</option>
              <option value="latest">Latest</option>
            </select>
          </div>
        </div>

        {initialSkillsLoading ? (
          <div aria-busy="true" aria-label="Loading Enterprise Skills" className="space-y-2">
            {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-xl border border-border bg-surface" />)}
          </div>
        ) : skillsError && !skillPage ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
            <p className="text-sm font-medium text-text-primary">Enterprise Skills could not be loaded.</p>
            <p className="mt-1 text-xs text-text-secondary">{skillsError}</p>
            <div className="mt-4 flex justify-center">
              <button type="button" onClick={onRetrySkills} className="rounded-lg bg-accent px-3 py-2 text-xs text-accent-foreground">Retry Skills</button>
            </div>
          </div>
        ) : skills.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-10 text-center">
            <p className="text-sm font-medium text-text-secondary">
              {filtered ? 'No Skills match your search.' : 'This enterprise has not published any Skills yet.'}
            </p>
            <p className="mt-1 text-xs text-text-tertiary">
              {filtered ? 'Try another keyword.' : 'Check back when the enterprise publishes Skills.'}
            </p>
            {filtered ? (
              <button type="button" onClick={() => onSkillKeywordChange('')} aria-label="Clear Skill filters" className="mt-4 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary">Clear search</button>
            ) : null}
          </div>
        ) : (
          <>
            {skillsError ? (
              <div role="status" className="flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:flex-row sm:items-center sm:justify-between dark:text-amber-300">
                <span>{skillsError}. Showing the last available page.</span>
                <button type="button" onClick={onRetrySkills} className="font-medium underline underline-offset-2">Retry page</button>
              </div>
            ) : null}
            {skillsLoading ? <p role="status" className="text-xs text-text-tertiary">Refreshing Enterprise Skills…</p> : null}
            <div className="space-y-2" aria-busy={skillsLoading}>
              {skills.map((item) => (
                <button
                  key={`${item.namespace}/${item.slug}`}
                  type="button"
                  data-enterprise-skill={`${item.namespace}/${item.slug}`}
                  onClick={() => onSelectSkill(item.namespace, item.slug)}
                  className="group flex w-full items-center gap-3 rounded-xl border border-border bg-white p-3.5 text-left shadow-sm transition hover:border-accent/35"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent/10 text-accent">
                    {item.iconUrl ? <img src={item.iconUrl} alt="" className="h-full w-full object-cover" /> : <span className="text-xs font-semibold">{item.displayName.slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium text-text-primary">{item.displayName}</h3>
                    <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{item.summary}</p>
                    <div className="mt-2 flex gap-3 text-[10px] text-text-tertiary">
                      <span>{item.namespace}/{item.slug}</span>
                      <span className="inline-flex items-center gap-1"><Download className="h-3 w-3" /> {formatCount(item.downloads)}</span>
                      <span className="inline-flex items-center gap-1"><Star className="h-3 w-3" /> {formatCount(item.stars)}</span>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                </button>
              ))}
            </div>
            <nav className="flex items-center justify-center gap-3 pt-1" aria-label="Enterprise Skill pagination">
              <button
                type="button"
                onClick={() => onSkillPageChange(Math.max(1, visiblePage - 1))}
                disabled={visiblePage <= 1 || skillsLoading}
                aria-label="Previous Skill page"
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs text-text-secondary disabled:opacity-50"
              ><ChevronLeft className="h-3.5 w-3.5" /> Previous</button>
              <span className="min-w-24 text-center text-xs text-text-tertiary">Page {visiblePage} of {totalPages}</span>
              <button
                type="button"
                onClick={() => onSkillPageChange(Math.min(totalPages, visiblePage + 1))}
                disabled={visiblePage >= totalPages || skillsLoading}
                aria-label="Next Skill page"
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs text-text-secondary disabled:opacity-50"
              >Next <ChevronRight className="h-3.5 w-3.5" /></button>
            </nav>
          </>
        )}
      </section>
    </div>
  )
}
