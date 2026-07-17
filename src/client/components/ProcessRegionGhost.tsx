import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronDown, Clock } from 'lucide-react'

import { useElapsed } from '../hooks/use-elapsed'
import { truncateStart } from './tool-renderers/path-utils'
import { ghostLatestLabel } from './process-region-ghost-label'
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

/** A stable key for the latest part so a new step remounts and replays the slide-in. */
function latestKey(part: RenderablePart): string {
  if (part.type === 'tool_use') return `tool-${part.toolUseId}`
  if (part.type === 'thinking') return 'thinking'
  return part.type
}

// Mirror FilePath's default cap so a long path left-truncates to its filename.
const PATH_DISPLAY_MAX = 40

/**
 * The collapsed representation of a process region in result-focused mode: a
 * low-weight one-line button showing the step count, elapsed duration, and the
 * latest step — including that step's key parameter (e.g. `Bash ▸ npm test`) so
 * a user can see what the agent is doing without opening the drawer (U4). It
 * expands into a side drawer on activation. Stays collapsed by design.
 */
export default function ProcessRegionGhost({ region, hasError, onOpen }: ProcessRegionGhostProps) {
  const { t } = useTranslation('chat')
  const latest = region.latest
  const isStreaming = (latest as { isStreaming?: boolean }).isStreaming === true

  const info = ghostLatestLabel(latest)
  const toolName = info.kind === 'tool' ? info.name : undefined
  const thinkingLabel = t('displayMode.thinking')
  // While the latest tool streams, its input is incomplete ({}) — show the name
  // only and reveal the parameter once the input lands (KTD4).
  const value = info.kind === 'tool' && !isStreaming ? info.value : undefined
  const displayValue =
    value !== undefined && info.kind === 'tool' && info.truncate === 'keep-tail'
      ? truncateStart(value, PATH_DISPLAY_MAX)
      : value
  const nameLabel = info.kind === 'thinking' ? thinkingLabel : (toolName ?? latest.type)
  // The aria string carries the full parameter (pre-truncation) for screen readers.
  const label = value !== undefined && toolName ? `${toolName} ▸ ${value}` : nameLabel

  const stepCount = region.parts.length

  const startTime = findFirstTimestamp(region.timestamps)
  const endTime = isStreaming ? undefined : findLastTimestamp(region.timestamps)
  const duration = useElapsed(startTime, endTime, isStreaming)
  const durationPlaceholder = t('displayMode.durationPlaceholder')
  const lessThanOneSecond = t('displayMode.durationLessThanOneSecond')
  const displayDuration = duration === '0s' ? lessThanOneSecond : duration

  // Throttle live duration announcements so screen readers are not interrupted
  // every second while a region is streaming.
  const durationRef = useRef(duration)
  const [announcedDuration, setAnnouncedDuration] = useState(duration)
  useEffect(() => {
    durationRef.current = duration
  }, [duration])
  useEffect(() => {
    if (!isStreaming) {
      setAnnouncedDuration(durationRef.current)
      return
    }
    setAnnouncedDuration(durationRef.current)
    const id = setInterval(() => {
      setAnnouncedDuration(durationRef.current)
    }, 5000)
    return () => clearInterval(id)
  }, [isStreaming])
  const displayAnnounced =
    announcedDuration === '0s' ? lessThanOneSecond : announcedDuration

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('displayMode.ghostLabel', {
        count: stepCount,
        latest: label,
      })}
      data-error={hasError ? 'true' : undefined}
      className="group/ghost my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 pl-0 pr-1.5 text-xs text-text-tertiary transition-colors motion-reduce:transition-none hover:text-text-primary"
    >
      <span aria-hidden="true" className="text-text-tertiary/60">
        {t('displayMode.processWord')}
      </span>
      <span className="tabular-nums min-w-fit shrink-0 whitespace-nowrap">{t('displayMode.steps', { count: stepCount })}</span>
      <span aria-hidden="true">·</span>
      <span className="tabular-nums min-w-fit shrink-0 whitespace-nowrap" data-testid="duration-visible">{displayDuration ?? durationPlaceholder}</span>
      <span aria-hidden="true">·</span>
      <span aria-live="polite" aria-atomic="true" className="sr-only" data-testid="duration-live">
        {displayAnnounced ?? durationPlaceholder}
      </span>
      <span className="inline-flex min-w-0 items-center gap-1">
        {/* Keyed by the latest step so each new step replays the slide-in. */}
        <span
          key={latestKey(latest)}
          className="inline-flex min-w-0 animate-slide-in-from-bottom items-center gap-1 motion-reduce:animate-none"
        >
          {displayValue !== undefined && toolName ? (
            <>
              <span>{toolName}</span>
              <span aria-hidden="true" className="text-text-tertiary/60">▸</span>
              <span className="min-w-0 truncate font-mono">{displayValue}</span>
            </>
          ) : (
            <span>{nameLabel}</span>
          )}
        </span>
        {isStreaming && <Clock className="size-3 animate-pulse text-warning" aria-hidden="true" />}
      </span>
      {hasError && <AlertCircle className="size-3 text-destructive" aria-hidden="true" />}
      <ChevronDown
        className="size-3 shrink-0 opacity-60 transition-opacity group-hover/ghost:opacity-100"
        aria-hidden="true"
      />
    </button>
  )
}
