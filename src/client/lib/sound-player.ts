// Minimal notification-sound player.
//
// Sounds are short clips served from /public (the app's self origin, allowed by
// the Tauri CSP `default-src 'self'`). The webview autoplay policy can block
// programmatic playback that fires from SSE events before any user gesture, so
// the player primes audio on the first user interaction and no-ops until then —
// a missed sound is preferable to a thrown error mid-stream.

export type SoundKind = 'attention' | 'completion'

const SOUND_URLS: Record<SoundKind, string> = {
  attention: '/attention.mp3',
  completion: '/completion.mp3',
}

let unlocked = false
const elements: Partial<Record<SoundKind, HTMLAudioElement>> = {}
let listenersAttached = false

function ensureElements(): void {
  for (const kind of Object.keys(SOUND_URLS) as SoundKind[]) {
    if (!elements[kind]) {
      const el = new Audio(SOUND_URLS[kind])
      el.preload = 'auto'
      elements[kind] = el
    }
  }
}

// Unlock programmatic playback via a silenced play on each element. Called from
// the first user gesture. Once a gesture has occurred, later SSE-triggered
// play() calls are permitted by the autoplay policy.
function unlock(): void {
  if (unlocked) return
  ensureElements()
  unlocked = true
  for (const kind of Object.keys(elements) as SoundKind[]) {
    const el = elements[kind]
    if (!el) continue
    el.muted = true
    el.currentTime = 0
    const p = el.play()
    if (p && typeof p.then === 'function') {
      p.then(() => {
        el.pause()
        el.muted = false
      }).catch(() => {
        el.muted = false
      })
    } else {
      el.muted = false
    }
  }
}

function attachGestureListeners(): void {
  if (listenersAttached || typeof window === 'undefined') return
  listenersAttached = true
  const handler = () => {
    unlock()
    window.removeEventListener('pointerdown', handler)
    window.removeEventListener('keydown', handler)
  }
  window.addEventListener('pointerdown', handler)
  window.addEventListener('keydown', handler)
}

// Prime on first interaction. Safe to invoke at module load.
attachGestureListeners()

export function playSound(kind: SoundKind, volume = 100): void {
  if (!unlocked) return // before the first user gesture — best-effort no-op
  if (!elements[kind]) ensureElements()
  const el = elements[kind]
  if (!el) return
  const clamped = Math.min(100, Math.max(0, volume))
  el.volume = clamped / 100
  el.currentTime = 0
  const p = el.play()
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // ignore autoplay/decode errors — sound is best-effort, never fatal
    })
  }
}

export function isSoundUnlocked(): boolean {
  return unlocked
}

// Test-only: reset internal state so unit tests start from a locked player.
export function __resetSoundPlayer(): void {
  unlocked = false
  for (const kind of Object.keys(elements) as SoundKind[]) {
    elements[kind] = undefined
  }
}

// Test-only: unlock as if a user gesture occurred, so the post-unlock play path
// can be exercised without a real DOM gesture.
export function __unlockSoundPlayer(): void {
  unlock()
}
