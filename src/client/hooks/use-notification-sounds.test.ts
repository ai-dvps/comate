import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatStore } from '../stores/chat-store'

const { settingsState, soundCalls } = vi.hoisted(() => ({
  settingsState: { notificationSoundsEnabled: true, notificationSoundsVolume: 100 },
  soundCalls: { attention: [] as number[], completion: [] as number[] },
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => settingsState,
}))
vi.mock('../lib/sound-player', () => ({
  playSound: (kind: 'attention' | 'completion', volume?: number) => {
    soundCalls[kind].push(volume ?? 100)
  },
}))

const { useNotificationSounds } = await import('../lib/use-notification-sounds')

function resetStore() {
  useChatStore.setState({
    approvalQueue: {},
    lastCompletion: {},
    streamStartedAt: {},
  })
}

function enqueue(sessionId: string, requestId: string) {
  useChatStore.setState((s) => ({
    approvalQueue: {
      ...s.approvalQueue,
      [sessionId]: [...(s.approvalQueue[sessionId] ?? []), { requestId, questions: [] }],
    },
  }))
}

function complete(sessionId: string, endedAt: number, isError: boolean, durationMs: number) {
  useChatStore.setState((s) => ({
    lastCompletion: {
      ...s.lastCompletion,
      [sessionId]: { endedAt, isError, durationMs },
    },
  }))
}

describe('useNotificationSounds', () => {
  beforeEach(() => {
    settingsState.notificationSoundsEnabled = true
    settingsState.notificationSoundsVolume = 100
    soundCalls.attention = []
    soundCalls.completion = []
    resetStore()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('covers AE2/AE3: a new approval/question requestId plays attention once', () => {
    renderHook(() => useNotificationSounds())
    expect(soundCalls.attention.length).toBe(0)
    act(() => enqueue('s1', 'req-1'))
    expect(soundCalls.attention.length).toBe(1)
    expect(soundCalls.attention[0]).toBe(100)
  })

  it('covers AE1: with sounds disabled, a new request plays nothing', () => {
    settingsState.notificationSoundsEnabled = false
    renderHook(() => useNotificationSounds())
    act(() => enqueue('s1', 'req-1'))
    expect(soundCalls.attention.length).toBe(0)
  })

  it('covers AE7: three new requestIds within the debounce window play once', () => {
    renderHook(() => useNotificationSounds())
    act(() => {
      enqueue('s1', 'req-1')
      enqueue('s1', 'req-2')
      enqueue('s1', 'req-3')
    })
    expect(soundCalls.attention.length).toBe(1)
  })

  it('covers AE4: a long, non-error completion plays the completion sound', () => {
    renderHook(() => useNotificationSounds())
    act(() => complete('s1', 10_000, false, 5000))
    expect(soundCalls.completion.length).toBe(1)
    expect(soundCalls.completion[0]).toBe(100)
  })

  it('covers AE5: a sub-threshold completion plays nothing', () => {
    renderHook(() => useNotificationSounds())
    act(() => complete('s1', 10_000, false, 1000))
    expect(soundCalls.completion.length).toBe(0)
  })

  it('covers AE6: an errored completion plays nothing', () => {
    renderHook(() => useNotificationSounds())
    act(() => complete('s1', 10_000, true, 5000))
    expect(soundCalls.completion.length).toBe(0)
  })

  it('is replay-safe: a requestId that already sounded does not re-sound', () => {
    renderHook(() => useNotificationSounds())
    act(() => enqueue('s1', 'req-1'))
    expect(soundCalls.attention.length).toBe(1)
    // Re-emit the same requestId (e.g. reconnect replay) — no additional sound.
    act(() =>
      useChatStore.setState((s) => ({
        approvalQueue: { ...s.approvalQueue, s1: [{ requestId: 'req-1', questions: [] }] },
      })),
    )
    expect(soundCalls.attention.length).toBe(1)
  })

  it('does not sound the initial pending snapshot on mount', () => {
    enqueue('s1', 'pre-existing')
    renderHook(() => useNotificationSounds())
    expect(soundCalls.attention.length).toBe(0)
  })

  it('passes the current volume to attention and completion sounds', () => {
    settingsState.notificationSoundsVolume = 42
    renderHook(() => useNotificationSounds())
    act(() => enqueue('s1', 'req-1'))
    act(() => complete('s1', 10_000, false, 5000))
    expect(soundCalls.attention[0]).toBe(42)
    expect(soundCalls.completion[0]).toBe(42)
  })

  it('still calls playSound with volume 0 when the slider is at 0%', () => {
    settingsState.notificationSoundsVolume = 0
    renderHook(() => useNotificationSounds())
    act(() => enqueue('s1', 'req-1'))
    expect(soundCalls.attention.length).toBe(1)
    expect(soundCalls.attention[0]).toBe(0)
  })
})
