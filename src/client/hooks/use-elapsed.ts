import { useEffect, useState } from 'react'

import { formatDuration } from '../lib/time'

interface ElapsedState {
  startTime: number
  mono: number
  wallOffset: number
  elapsed: number
  maxElapsed: number
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Format an elapsed duration between a start time and an optional end time.
 *
 * While `isRunning` is true the value ticks up once per second using a local
 * monotonic anchor, so wall-clock skew (NTP adjustments, sleep/wake, tab
 * throttling catch-up) cannot inflate the displayed duration. When running
 * stops the value freezes to the maximum elapsed observed, which prevents a
 * snap-back to an earlier completion timestamp.
 */
export function useElapsed(
  startTime: number,
  endTime: number | undefined,
  isRunning: boolean,
): string
export function useElapsed(
  startTime: number | undefined,
  endTime: number | undefined,
  isRunning: boolean,
): string | undefined
export function useElapsed(
  startTime: number | undefined,
  endTime: number | undefined,
  isRunning: boolean,
): string | undefined {
  const [state, setState] = useState<ElapsedState | null>(() => {
    if (startTime === undefined) return null
    const mono = now()
    const wallOffset = Date.now() - startTime
    const elapsed = isRunning
      ? wallOffset
      : (endTime ?? Date.now()) - startTime
    return {
      startTime,
      mono,
      wallOffset,
      elapsed,
      maxElapsed: elapsed,
    }
  })

  // Reset the local anchor whenever the logical start time changes (e.g. a
  // process region is reconstructed with different timestamps). endTime and
  // isRunning are intentionally omitted; they are handled by the tick effect.
  useEffect(() => {
    if (startTime === undefined) {
      setState(null)
      return
    }
    const mono = now()
    const wallOffset = Date.now() - startTime
    const elapsed = isRunning
      ? wallOffset
      : (endTime ?? Date.now()) - startTime
    setState({
      startTime,
      mono,
      wallOffset,
      elapsed,
      maxElapsed: elapsed,
    })
  }, [startTime]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tick the elapsed value. The full `state` object is intentionally omitted
  // from dependencies; we key off state.startTime so the effect does not loop.
  useEffect(() => {
    if (state === null) return

    const compute = (): number => {
      if (!isRunning) return (endTime ?? Date.now()) - state.startTime
      return (now() - state.mono) + state.wallOffset
    }

    const tick = () => {
      const next = compute()
      setState((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          elapsed: next,
          maxElapsed: Math.max(prev.maxElapsed, next),
        }
      })
    }

    tick()
    if (!isRunning) return

    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [state?.startTime, endTime, isRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  if (startTime === undefined || state === null) return undefined

  const finalElapsed = isRunning
    ? state.elapsed
    : Math.max(state.elapsed, state.maxElapsed)
  return formatDuration(finalElapsed)
}
