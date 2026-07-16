import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronDown, Clock } from 'lucide-react'

import { formatDuration } from '../lib/time'
import type { ProcessRegion } from './message-grouping'
import type { RenderablePart } from './chat-message-adapter'

interface ProcessRegionGhostProps {
  region: ProcessRegion
  hasError: boolean
  onOpen: () => void
}

function findFirstTimestamp(timestamps: (number | undefined)[]): number | undefined {
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] !== undefined) return timestamps[i]
  }
  return undefined
}

function findLastTimestamp(timestamps: (number | undefined)[]): number | undefined {
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] !== undefined) return timestamps[i]
  }
  return undefined
}

function useRegionDuration(
  timestamps: (number | undefined)[],
  isRunning: boolean,
): string | undefined {
  const startTime = findFirstTimestamp(timestamps)
  const endTime = isRunning ? undefined : findLastTimestamp(timestamps)

  const [state, setState] = useState(() => {
    if (startTime === undefined) return { elapsed: 0, maxElapsed: 0 }
    const base = isRunning ? Date.now() : (endTime ?? Date.now())
    const elapsed = base - startTime
    return { elapsed, maxElapsed: elapsed }
  })

  useEffect(() => {
    if (startTime === undefined) return

    const update = () => {
      const base = isRunning ? Date.now() : (endTime ?? Date.now())
      const next = base - startTime
      setState((prev) => ({
        elapsed: next,
        maxElapsed: Math.max(prev.maxElapsed, next),
      }))
    }

    update()
    if (!isRunning) return

    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [startTime, endTime, isRunning])

  if (startTime === undefined) return undefined

  const finalElapsed = isRunning ? state.elapsed : Math.max(state.elapsed, state.maxElapsed)
  return formatDuration(finalElapsed)
}

/** A stable key for the latest part so a new step remounts and replays the slide-in. */
function latestKey(part: RenderablePart): string {
  if (part.type === 'tool_use') return `tool-${part.toolUseId}`
  if (part.type === 'thinking') return 'thinking'
  return part.type
}

/**
 * The collapsed representation of a process region in result-focused mode: a
 * low-weight one-line button showing the step count and the latest step. It
 * expands into a side drawer on activation (U4). Stays collapsed by design.
 */
export default function ProcessRegionGhost({ region, hasError, onOpen }: ProcessRegionGhostProps) {
  const { t } = useTranslation('chat')
  const latest = region.latest
  const isStreaming = (latest as { isStreaming?: boolean }).isStreaming === true
  const label =
    latest.type === 'tool_use'
      ? latest.meta?.displayName ?? latest.toolName
      : latest.type === 'thinking'
        ? t('displayMode.thinking')
        : latest.type
  const stepCount = region.parts.length
  const duration = useRegionDuration(region.timestamps, isStreaming)

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('displayMode.ghostLabel', {
        count: stepCount,
        duration: duration ?? '—',
        latest: label,
      })}
      data-error={hasError ? 'true' : undefined}
      className="group/ghost my-0.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-text-tertiary transition-colors motion-reduce:transition-none hover:text-text-primary"
    >
      <span aria-hidden="true" className="text-text-tertiary/60">
        {t('displayMode.processWord')}
      </span>
      <span className="tabular-nums">{t('displayMode.steps', { count: stepCount })}</span>
      <span aria-hidden="true">·</span>
      <span className="tabular-nums">{duration ?? '—'}</span>
      <span aria-hidden="true">·</span>
      <span aria-live="polite" className="inline-flex items-center gap-1">
        {/* Keyed by the latest step so each new step replays the slide-in. */}
        <span
          key={latestKey(latest)}
          className="inline-block animate-slide-in-from-bottom motion-reduce:animate-none"
        >
          {label}
        </span>
        {isStreaming && <Clock className="size-3 animate-pulse text-warning" aria-hidden="true" />}
      </span>
      {hasError && <AlertCircle className="size-3 text-destructive" aria-hidden="true" />}
      <ChevronDown
        className="size-3 opacity-60 transition-opacity group-hover/ghost:opacity-100"
        aria-hidden="true"
      />
    </button>
  )
}
