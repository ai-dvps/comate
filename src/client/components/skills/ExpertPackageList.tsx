import { ArrowRight, Boxes, Globe2, Grid2X2, List, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ExpertPackageScene,
  ExpertPackageSummary,
} from '../../stores/expert-packages-store'

export type ExpertPackageViewMode = 'cards' | 'list'

interface ExpertPackageListProps {
  packages: ExpertPackageSummary[]
  total: number
  keyword: string
  scene?: ExpertPackageScene
  viewMode: ExpertPackageViewMode
  loading: boolean
  error: string | null
  onKeywordChange: (value: string) => void
  onSceneChange: (value?: ExpertPackageScene) => void
  onViewModeChange: (value: ExpertPackageViewMode) => void
  onSelect: (slug: string) => void
  onRetry: () => void
}

const scenes: ExpertPackageScene[] = [
  'tech', 'content-creation', 'design', 'marketing', 'finance', 'education',
  'ecommerce', 'media', 'academic', 'healthcare', 'hr', 'legal', 'lifestyle', 'mysticism',
]

export default function ExpertPackageList({
  packages, total, keyword, scene, viewMode, loading, error,
  onKeywordChange, onSceneChange, onViewModeChange, onSelect, onRetry,
}: ExpertPackageListProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="rounded-2xl border border-border bg-surface px-5 py-5 shadow-sm">
        <div className="flex justify-end">
          <p className="text-xs text-text-tertiary">{t('skills.expertPackages.total', { count: total })}</p>
        </div>

        <div className="mt-3 flex flex-col gap-2 lg:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <input
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              placeholder={t('skills.expertPackages.searchPlaceholder')}
              aria-label={t('skills.expertPackages.searchLabel')}
              className="h-10 w-full rounded-xl border border-border bg-bg pl-9 pr-9 text-xs text-text-primary outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            {keyword && (
              <button
                onClick={() => onKeywordChange('')}
                className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-text-tertiary hover:text-text-primary"
                aria-label={t('skills.expertPackages.clearSearch')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <select
            value={scene || ''}
            onChange={(event) => onSceneChange(event.target.value as ExpertPackageScene || undefined)}
            aria-label={t('skills.expertPackages.sceneFilter')}
            className="h-10 min-w-40 rounded-xl border border-border bg-bg px-3 text-xs text-text-secondary outline-none focus:border-accent"
          >
            <option value="">{t('skills.expertPackages.allScenes')}</option>
            {scenes.map((item) => <option key={item} value={item}>{t(`skills.expertPackages.scenes.${item}`)}</option>)}
          </select>
          <div className="flex h-10 rounded-xl border border-border bg-bg p-1" aria-label={t('skills.expertPackages.viewMode')}>
            <button
              onClick={() => onViewModeChange('cards')}
              aria-pressed={viewMode === 'cards'}
              aria-label={t('skills.expertPackages.cardView')}
              className={`flex w-9 items-center justify-center rounded-lg ${viewMode === 'cards' ? 'bg-surface text-accent shadow-sm' : 'text-text-tertiary'}`}
            ><Grid2X2 className="h-3.5 w-3.5" /></button>
            <button
              onClick={() => onViewModeChange('list')}
              aria-pressed={viewMode === 'list'}
              aria-label={t('skills.expertPackages.listView')}
              className={`flex w-9 items-center justify-center rounded-lg ${viewMode === 'list' ? 'bg-surface text-accent shadow-sm' : 'text-text-tertiary'}`}
            ><List className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      </header>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label={t('skills.expertPackages.loading')}>
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl border border-border bg-surface" />)}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
          <p className="text-sm font-medium text-text-primary">{t('skills.expertPackages.loadFailed')}</p>
          <p className="mt-1 text-xs text-text-secondary">{error}</p>
          <button onClick={onRetry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-foreground">{t('skills.expertPackages.retry')}</button>
        </div>
      ) : packages.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-10 text-center">
          <Boxes className="mx-auto h-8 w-8 text-text-tertiary" />
          <p className="mt-3 text-sm font-medium text-text-secondary">{t(keyword || scene ? 'skills.expertPackages.noMatches' : 'skills.expertPackages.empty')}</p>
          <p className="mt-1 text-xs text-text-tertiary">{t(keyword || scene ? 'skills.expertPackages.adjustFilters' : 'skills.expertPackages.comeBack')}</p>
        </div>
      ) : (
        <div className={viewMode === 'cards' ? 'grid grid-cols-1 gap-3 md:grid-cols-2' : 'space-y-2'}>
          {packages.map((item) => (
            <button
              key={item.slug}
              onClick={() => onSelect(item.slug)}
              className={`group w-full rounded-2xl border border-border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md motion-reduce:transform-none ${viewMode === 'cards' ? 'p-4' : 'p-3.5'}`}
            >
              {viewMode === 'cards' ? (
                <>
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                      <Boxes className="h-4.5 w-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-text-primary">{item.displayName}</h3>
                          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">{t('skills.expertPackages.expert', { scene: item.subScene || item.scene })}</p>
                        </div>
                        <ArrowRight className="h-4 w-4 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-3 min-h-15 text-xs leading-5 text-text-secondary">{item.summary}</p>
                  <div className="mt-3 flex items-center gap-2 text-[10px] text-text-tertiary">
                    <span className="rounded-md border border-border/60 bg-white px-2 py-1">{t('skills.expertPackages.skillCount', { count: item.skillCount })}</span>
                    <span className="inline-flex items-center gap-1"><Globe2 className="h-3 w-3" /> SkillHub</span>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Boxes className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-text-primary">{item.displayName}</h3>
                      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">{t('skills.expertPackages.expert', { scene: item.subScene || item.scene })}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                  </div>
                  <p className="mt-2 line-clamp-1 text-xs leading-5 text-text-secondary">{item.summary}</p>
                  <div className="mt-3 flex items-center gap-2 text-[10px] text-text-tertiary">
                    <span className="rounded-md border border-border/60 bg-white px-2 py-1">{t('skills.expertPackages.skillCount', { count: item.skillCount })}</span>
                    <span className="inline-flex items-center gap-1"><Globe2 className="h-3 w-3" /> SkillHub</span>
                  </div>
                  </div>
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
