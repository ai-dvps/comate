import { ChevronDown, ChevronLeft, ChevronRight, LocateFixed, RefreshCw, Search, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitGraphRef } from '../../stores/git-graph-store'
import { cn } from '../ui/utils'

interface GitGraphToolbarProps {
  refs: GitGraphRef[]
  selectedRefs: string[]
  searchText: string
  matchCount: number
  activeMatch: number
  loading: boolean
  hasMore: boolean
  onFilterChange: (refs: string[]) => void
  onSearchChange: (value: string) => void
  onPreviousMatch: () => void
  onNextMatch: () => void
  onLocateHead: () => void
  onRefresh: () => void
  onLoadMore: () => void
}

export default function GitGraphToolbar({
  refs,
  selectedRefs,
  searchText,
  matchCount,
  activeMatch,
  loading,
  hasMore,
  onFilterChange,
  onSearchChange,
  onPreviousMatch,
  onNextMatch,
  onLocateHead,
  onRefresh,
  onLoadMore,
}: GitGraphToolbarProps) {
  const { t } = useTranslation('common')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterLabel = selectedRefs.length === 0
    ? t('gitGraph.allBranches')
    : t('gitGraph.selectedBranches', { count: selectedRefs.length })

  const toggleRef = (fullName: string, checked: boolean) => {
    const next = checked
      ? [...selectedRefs, fullName]
      : selectedRefs.filter((ref) => ref !== fullName)
    onFilterChange(next)
  }

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 border-b border-border/70 bg-chrome px-2 py-1.5">
      <div className="relative">
        <button
          type="button"
          className="flex h-7 max-w-44 items-center gap-1 rounded border border-border/80 bg-work px-2 text-[11px] text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => setFilterOpen((open) => !open)}
          aria-label={t('gitGraph.filterBranches')}
          aria-expanded={filterOpen}
        >
          <span className="truncate">{filterLabel}</span>
          <ChevronDown className="h-3 w-3 flex-none" aria-hidden="true" />
        </button>
        {filterOpen ? (
          <div className="absolute left-0 top-8 z-30 max-h-64 min-w-56 overflow-auto rounded border border-border bg-chrome p-1 shadow-lg">
            <button
              type="button"
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-[11px] text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => onFilterChange([])}
              aria-pressed={selectedRefs.length === 0}
            >
              {t('gitGraph.allBranches')}
            </button>
            {refs.map((ref) => (
              <label key={ref.fullName} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[11px] text-text-secondary hover:bg-surface-hover">
                <input
                  type="checkbox"
                  aria-label={ref.name}
                  checked={selectedRefs.includes(ref.fullName)}
                  onChange={(event) => toggleRef(ref.fullName, event.currentTarget.checked)}
                  className="accent-accent"
                />
                <span className="min-w-0 flex-1 truncate">{ref.name}</span>
                <span className="text-[10px] uppercase text-text-tertiary">{ref.type}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex h-7 min-w-40 flex-1 items-center rounded border border-border/80 bg-work focus-within:ring-2 focus-within:ring-accent">
        <Search className="ml-2 h-3.5 w-3.5 flex-none text-text-tertiary" aria-hidden="true" />
        <input
          type="search"
          value={searchText}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          aria-label={t('gitGraph.searchLabel')}
          placeholder={t('gitGraph.searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent px-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {searchText ? (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="flex h-6 w-6 items-center justify-center text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={t('gitGraph.clearSearch')}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {searchText ? (
        <div className="flex items-center gap-0.5" aria-live="polite">
          <span className={cn('whitespace-nowrap px-1 text-[10px]', matchCount ? 'text-text-secondary' : 'text-text-tertiary')}>
            {matchCount
              ? t('gitGraph.matchPosition', { current: activeMatch + 1, count: matchCount })
              : t('gitGraph.noLoadedMatches')}
          </span>
          <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={onPreviousMatch} disabled={matchCount === 0} aria-label={t('gitGraph.previousMatch')}>
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={onNextMatch} disabled={matchCount === 0} aria-label={t('gitGraph.nextMatch')}>
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={onLocateHead} aria-label={t('gitGraph.locateHead')}>
        <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={onRefresh} disabled={loading} aria-label={t('gitGraph.refresh')}>
        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loading || !hasMore}
        className="h-7 rounded px-2 text-[11px] text-text-secondary hover:bg-surface-hover disabled:cursor-default disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={t('gitGraph.loadMore')}
      >
        {hasMore ? t('gitGraph.loadMoreShort') : t('gitGraph.allLoaded')}
      </button>
    </div>
  )
}
