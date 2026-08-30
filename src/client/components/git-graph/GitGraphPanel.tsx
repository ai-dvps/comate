import { GitBranch, LoaderCircle, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useContextTabStore } from '../../stores/context-tab-store'
import { GIT_GRAPH_MAX_LIMIT, getGitGraphWorkspaceState, useGitGraphStore, type GitGraphChangedFile } from '../../stores/git-graph-store'
import GitCommitDetails from './GitCommitDetails'
import GitGraphRows from './GitGraphRows'
import GitGraphToolbar from './GitGraphToolbar'

interface GitGraphPanelProps {
  workspaceId: string
}

export default function GitGraphPanel({ workspaceId }: GitGraphPanelProps) {
  const { t } = useTranslation('common')
  const state = useGitGraphStore((store) => store.workspaces[workspaceId])
  const snapshot = state?.snapshot ?? null
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const restoredAnchor = useRef(false)
  const currentScrollAnchor = useRef<number | null>(state?.scrollAnchor ?? null)
  const [headMessage, setHeadMessage] = useState<string | null>(null)

  useEffect(() => {
    const current = getGitGraphWorkspaceState(workspaceId)
    if (!current.snapshot && !current.snapshotLoading) void useGitGraphStore.getState().open(workspaceId)
  }, [workspaceId])

  useEffect(() => () => {
    useGitGraphStore.getState().setScrollAnchor(workspaceId, currentScrollAnchor.current)
  }, [workspaceId])

  useEffect(() => {
    const handleFocus = () => {
      if (document.visibilityState === 'visible') void useGitGraphStore.getState().refocus(workspaceId)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [workspaceId])

  useEffect(() => {
    if (!state?.selectedCommitHash || state.detailLoading || state.detailError) return
    if (state.detail?.hash !== state.selectedCommitHash) {
      void useGitGraphStore.getState().selectCommit(workspaceId, state.selectedCommitHash)
    }
  }, [state?.selectedCommitHash, state?.detail?.hash, state?.detailError, state?.detailLoading, workspaceId])

  useEffect(() => {
    if (restoredAnchor.current || !listRef.current || state?.scrollAnchor == null) return
    listRef.current.scrollTop = state.scrollAnchor
    restoredAnchor.current = true
  }, [state?.scrollAnchor, snapshot])

  const activeMatchHash = state && state.activeSearchMatch >= 0
    ? state.searchMatches[state.activeSearchMatch]
    : undefined
  useEffect(() => {
    if (!activeMatchHash) return
    const row = rowRefs.current.get(activeMatchHash)
    row?.scrollIntoView({ block: 'nearest' })
    row?.focus()
  }, [activeMatchHash])

  const selectedCommit = useMemo(
    () => snapshot?.commits.find((commit) => commit.hash === state?.selectedCommitHash) ?? null,
    [snapshot, state?.selectedCommitHash],
  )
  const matches = useMemo(() => new Set(state?.searchMatches ?? []), [state?.searchMatches])

  const selectCommit = useCallback((hash: string) => {
    setHeadMessage(null)
    void useGitGraphStore.getState().selectCommit(workspaceId, hash)
  }, [workspaceId])

  const locateHead = useCallback(() => {
    const current = getGitGraphWorkspaceState(workspaceId)
    const headHash = current.snapshot?.capability.headHash
    if (!headHash) {
      setHeadMessage(t('gitGraph.noHead'))
      return
    }
    const row = rowRefs.current.get(headHash)
    if (!row) {
      setHeadMessage(t('gitGraph.headOutsideFilter'))
      return
    }
    setHeadMessage(null)
    row.scrollIntoView({ block: 'center' })
    row.focus()
    void useGitGraphStore.getState().selectCommit(workspaceId, headHash)
  }, [t, workspaceId])

  const openFile = useCallback((file: GitGraphChangedFile) => {
    const current = getGitGraphWorkspaceState(workspaceId)
    if (!current.detail) return
    void useContextTabStore.getState().openCommitDiff(workspaceId, current.detail.hash, current.detail.baseHash, file)
  }, [workspaceId])

  if (!snapshot && state?.snapshotLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-text-tertiary" role="status">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t('gitGraph.loadingHistory')}
      </div>
    )
  }

  if (!snapshot && state?.snapshotError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-xs">
        <GitBranch className="h-7 w-7 text-text-tertiary" aria-hidden="true" />
        <p className="text-destructive">{state.snapshotError}</p>
        <button type="button" className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => void useGitGraphStore.getState().refresh(workspaceId)}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('gitGraph.retry')}
        </button>
      </div>
    )
  }

  if (!snapshot) return null

  return (
    <div data-testid="git-graph-container" className="flex h-full min-h-0 flex-col bg-work">
      <GitGraphToolbar
        refs={snapshot.refs.filter((ref) => ref.type !== 'tag')}
        selectedRefs={state?.selectedRefs ?? []}
        searchText={state?.searchText ?? ''}
        matchCount={state?.searchMatches.length ?? 0}
        activeMatch={state?.activeSearchMatch ?? -1}
        loading={state?.snapshotLoading ?? false}
        hasMore={snapshot.hasMore && (state?.loadedLimit ?? 0) < GIT_GRAPH_MAX_LIMIT}
        onFilterChange={(refs) => void useGitGraphStore.getState().setFilters(workspaceId, refs)}
        onSearchChange={(value) => useGitGraphStore.getState().setSearchText(workspaceId, value)}
        onPreviousMatch={() => useGitGraphStore.getState().previousSearchMatch(workspaceId)}
        onNextMatch={() => useGitGraphStore.getState().nextSearchMatch(workspaceId)}
        onLocateHead={locateHead}
        onRefresh={() => void useGitGraphStore.getState().refresh(workspaceId)}
        onLoadMore={() => void useGitGraphStore.getState().loadMore(workspaceId)}
      />
      {state?.snapshotError ? (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-[10px] text-destructive" role="alert">
          <span className="truncate">{state.snapshotError}</span>
          <button type="button" className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => void useGitGraphStore.getState().refresh(workspaceId)}>{t('gitGraph.retry')}</button>
        </div>
      ) : null}
      {headMessage ? <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-[10px] text-text-secondary" role="status">{headMessage}</div> : null}
      {snapshot.commits.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <GitBranch className="h-7 w-7 text-text-tertiary" aria-hidden="true" />
          <p className="text-xs text-text-secondary">{snapshot.capability.state === 'unborn' ? t('gitGraph.emptyRepository') : t('gitGraph.emptyFilter')}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-[3] flex-col border-b border-border/70">
          <GitGraphRows
            commits={snapshot.commits}
            selectedHash={state?.selectedCommitHash ?? null}
            searchMatches={matches}
            listRef={listRef}
            rowRefs={rowRefs}
            onSelect={selectCommit}
            onAnchorChange={(scrollTop) => { currentScrollAnchor.current = scrollTop }}
            historyLabel={t('gitGraph.commitHistory')}
          />
        </div>
      )}
      <div className="min-h-28 flex-[2] overflow-hidden">
        <GitCommitDetails
          commit={selectedCommit}
          detail={state?.detail ?? null}
          loading={state?.detailLoading ?? false}
          error={state?.detailError ?? null}
          onRetry={() => {
            if (state?.selectedCommitHash) void useGitGraphStore.getState().selectCommit(workspaceId, state.selectedCommitHash)
          }}
          onOpenFile={openFile}
        />
      </div>
    </div>
  )
}
