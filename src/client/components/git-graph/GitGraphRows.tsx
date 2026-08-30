import { memo, useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { GitBranch, Tag } from 'lucide-react'
import { buildGitGraphLayout } from '../../lib/git-graph-layout'
import type { GitGraphCommit, GitGraphRef } from '../../stores/git-graph-store'
import { cn } from '../ui/utils'

export const GIT_GRAPH_ROW_HEIGHT = 44
const LANE_WIDTH = 14

const LANE_COLORS = [
  'hsl(var(--color-accent))',
  'hsl(var(--color-success))',
  'hsl(var(--color-warning))',
  'hsl(var(--color-destructive))',
  'hsl(var(--color-text-tertiary))',
]

interface GitGraphRowsProps {
  commits: GitGraphCommit[]
  selectedHash: string | null
  searchMatches: Set<string>
  listRef: RefObject<HTMLDivElement>
  rowRefs: RefObject<Map<string, HTMLButtonElement>>
  onSelect: (hash: string) => void
  onAnchorChange: (scrollTop: number) => void
  historyLabel: string
}

function refClasses(ref: GitGraphRef): string {
  if (ref.type === 'local') return 'border-accent/50 bg-accent/10 text-accent'
  if (ref.type === 'remote') return 'border-success/50 bg-success/10 text-success'
  return 'border-warning/50 bg-warning/10 text-warning'
}

function refIcon(ref: GitGraphRef) {
  return ref.type === 'tag'
    ? <Tag className="h-2.5 w-2.5" aria-hidden="true" />
    : <GitBranch className="h-2.5 w-2.5" aria-hidden="true" />
}

function GitGraphRows({ commits, selectedHash, searchMatches, listRef, rowRefs, onSelect, onAnchorChange, historyLabel }: GitGraphRowsProps) {
  const layout = useMemo(() => buildGitGraphLayout(commits), [commits])
  const graphWidth = Math.max(38, layout.laneCount * LANE_WIDTH + 20)
  const nodeByHash = useMemo(() => new Map(layout.nodes.map((node) => [node.hash, node])), [layout.nodes])
  const [focusedHash, setFocusedHash] = useState(selectedHash ?? commits[0]?.hash ?? null)

  useEffect(() => {
    if (selectedHash) setFocusedHash(selectedHash)
    else if (focusedHash && !commits.some((commit) => commit.hash === focusedHash)) {
      setFocusedHash(commits[0]?.hash ?? null)
    }
  }, [commits, focusedHash, selectedHash])

  const focusRow = (index: number) => {
    const commit = commits[index]
    if (!commit) return
    setFocusedHash(commit.hash)
    const row = rowRefs.current?.get(commit.hash)
    row?.focus()
    row?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={historyLabel}
      className="relative min-h-0 flex-1 overflow-auto scroll-py-2 bg-work"
      onScroll={(event) => onAnchorChange(event.currentTarget.scrollTop)}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-10"
        width={graphWidth}
        height={Math.max(GIT_GRAPH_ROW_HEIGHT, commits.length * GIT_GRAPH_ROW_HEIGHT)}
        viewBox={`0 0 ${graphWidth} ${Math.max(GIT_GRAPH_ROW_HEIGHT, commits.length * GIT_GRAPH_ROW_HEIGHT)}`}
      >
        {layout.edges.map((edge) => {
          const x1 = edge.fromLane * LANE_WIDTH + 13
          const x2 = edge.toLane * LANE_WIDTH + 13
          const y1 = edge.fromRow * GIT_GRAPH_ROW_HEIGHT + GIT_GRAPH_ROW_HEIGHT / 2
          const y2 = edge.toRow * GIT_GRAPH_ROW_HEIGHT + GIT_GRAPH_ROW_HEIGHT / 2
          const midY = y1 + Math.min(18, Math.max(8, (y2 - y1) / 2))
          return (
            <path
              key={`${edge.fromHash}:${edge.toHash}:${edge.parentIndex}`}
              d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
              fill="none"
              stroke={LANE_COLORS[edge.toLane % LANE_COLORS.length]}
              strokeWidth="1.5"
              strokeDasharray={edge.clipped ? '3 2' : undefined}
              opacity="0.8"
            />
          )
        })}
        {layout.nodes.map((node) => (
          <circle
            key={node.hash}
            cx={node.lane * LANE_WIDTH + 13}
            cy={node.row * GIT_GRAPH_ROW_HEIGHT + GIT_GRAPH_ROW_HEIGHT / 2}
            r={commits[node.row]?.isHead ? 5 : 4}
            fill="hsl(var(--color-work))"
            stroke={LANE_COLORS[node.lane % LANE_COLORS.length]}
            strokeWidth={commits[node.row]?.isHead ? 3 : 2}
          />
        ))}
      </svg>

      {commits.map((commit, index) => {
        const selected = commit.hash === selectedHash
        const matched = searchMatches.has(commit.hash)
        const lane = nodeByHash.get(commit.hash)?.lane ?? 0
        return (
          <button
            key={commit.hash}
            ref={(node) => {
              if (node) rowRefs.current?.set(commit.hash, node)
              else rowRefs.current?.delete(commit.hash)
            }}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={`${commit.subject}, ${commit.authorName}, ${commit.shortHash}${commit.isHead ? ', HEAD' : ''}`}
            tabIndex={commit.hash === focusedHash ? 0 : -1}
            data-commit-hash={commit.hash}
            data-lane={lane}
            onClick={() => onSelect(commit.hash)}
            onFocus={() => setFocusedHash(commit.hash)}
            onKeyDown={(event) => {
              let target = index
              if (event.key === 'ArrowDown') target = Math.min(commits.length - 1, index + 1)
              else if (event.key === 'ArrowUp') target = Math.max(0, index - 1)
              else if (event.key === 'Home') target = 0
              else if (event.key === 'End') target = commits.length - 1
              else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(commit.hash)
                return
              } else return
              event.preventDefault()
              focusRow(target)
            }}
            className={cn(
              'group relative flex w-full items-center border-b border-border/35 pr-2 text-left focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              selected ? 'bg-accent/10' : 'hover:bg-surface-hover/70',
              matched && !selected && 'bg-warning/10',
            )}
            style={{
              height: GIT_GRAPH_ROW_HEIGHT,
              paddingLeft: graphWidth,
              contentVisibility: 'auto',
              containIntrinsicSize: `${GIT_GRAPH_ROW_HEIGHT}px`,
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{commit.subject}</span>
              <div className="flex max-w-48 min-w-0 items-center gap-1 overflow-hidden">
                {commit.isHead ? (
                  <span className="rounded border border-accent/60 bg-accent/15 px-1 py-0.5 text-[9px] font-semibold text-accent">HEAD</span>
                ) : null}
                {commit.refs.map((ref) => (
                  <span
                    key={ref.fullName}
                    data-ref-type={ref.type}
                    className={cn('flex max-w-32 items-center gap-0.5 truncate rounded border px-1 py-0.5 text-[9px]', refClasses(ref))}
                  >
                    {refIcon(ref)}
                    <span className="truncate">{ref.name}</span>
                  </span>
                ))}
              </div>
              <span className="w-20 truncate text-right text-[10px] text-text-tertiary">{commit.authorName}</span>
              <code className="w-14 text-right text-[10px] text-text-tertiary">{commit.shortHash}</code>
            </div>
          </button>
        )
      })}
    </div>
  )
}

export default memo(GitGraphRows)
