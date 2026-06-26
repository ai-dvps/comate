import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chat-store'
import { useAppSettings } from '../hooks/use-app-settings'
import { playSound } from './sound-player'

// Minimum turn duration (ms) for the completion sound to fire — short
// back-and-forth turns stay silent. Tunable.
const COMPLETION_MIN_DURATION_MS = 3000
// Coalesce window (ms): multiple new attention requests within this window play
// a single sound (leading-edge play, then suppress for the window).
const ATTENTION_DEBOUNCE_MS = 1500

/**
 * Plays notification sounds in response to chat-store state:
 *  - the "attention" sound when a tool approval or AskUserQuestion becomes
 *    pending, and
 *  - the "completion" sound when a non-error turn longer than the duration guard
 *    ends and Claude goes idle.
 *
 * Gated by the `notificationSoundsEnabled` setting. Replay-safe — it dedupes by
 * requestId (attention) and by completion end time, so reconnect replays do not
 * re-sound. The initial state snapshot is absorbed silently, so a cold launch
 * with pre-existing pending requests relies on the dock badge rather than
 * firing a surprise sound.
 *
 * Modeled on {@link useBadgeSync}: a React hook mounted once in the app that
 * subscribes to store state and performs a side-effect, keeping the store and
 * its replay-sensitive SSE handlers free of audio concerns.
 */
export function useNotificationSounds(): void {
  const enabled = useAppSettings().notificationSoundsEnabled
  const approvalQueue = useChatStore((s) => s.approvalQueue)
  const lastCompletion = useChatStore((s) => s.lastCompletion)

  const soundedRequestIds = useRef<Set<string>>(new Set())
  const lastSoundedEndedAt = useRef<Record<string, number>>({})
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attentionReady = useRef(false)
  const completionReady = useRef(false)

  // Attention sound — fires when a new requestId appears in any session's
  // approval/question queue.
  useEffect(() => {
    const allIds = new Set<string>()
    for (const items of Object.values(approvalQueue)) {
      for (const item of items ?? []) {
        if (item.requestId) allIds.add(item.requestId)
      }
    }
    let hasNew = false
    for (const id of allIds) {
      if (!soundedRequestIds.current.has(id)) {
        soundedRequestIds.current.add(id)
        hasNew = true
      }
    }

    // Absorb the initial snapshot silently so a cold launch (or reconnect) with
    // pre-existing pending requests does not fire a surprise sound.
    if (!attentionReady.current) {
      attentionReady.current = true
      return
    }
    if (!enabled || !hasNew) return

    // Leading-edge play, then suppress for the coalesce window so a burst of
    // requests produces a single sound.
    if (debounceTimer.current) return
    playSound('attention')
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null
    }, ATTENTION_DEBOUNCE_MS)
  }, [approvalQueue, enabled])

  // Completion sound — fires when a session's completion advances to a
  // non-error turn that exceeded the duration guard.
  useEffect(() => {
    for (const [sid, completion] of Object.entries(lastCompletion)) {
      if (!completion) continue
      const last = lastSoundedEndedAt.current[sid] ?? 0
      if (completion.endedAt <= last) continue
      lastSoundedEndedAt.current[sid] = completion.endedAt
      if (
        enabled &&
        completionReady.current &&
        !completion.isError &&
        completion.durationMs >= COMPLETION_MIN_DURATION_MS
      ) {
        playSound('completion')
      }
    }
    completionReady.current = true
  }, [lastCompletion, enabled])

  // Clear the coalesce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
        debounceTimer.current = null
      }
    }
  }, [])
}
