// Minimal notification-sound player.
//
// Sounds are short clips served from /public (the app's self origin, allowed by
// the Tauri CSP `default-src 'self'`). The webview autoplay policy can block
// programmatic playback that fires from SSE events before any user gesture, so
// the player primes audio on the first user interaction and no-ops until then —
// a missed sound is preferable to a thrown error mid-stream.
//
// To make the bundled clips audible even when the UI volume slider is at 100%,
// the player routes each <audio> element through a Web Audio graph with a fixed
// gain node. If the Web Audio API is unavailable, it falls back to the plain
// element playback.

export type SoundKind = 'attention' | 'completion'

const SOUND_URLS: Record<SoundKind, string> = {
  attention: '/attention.mp3',
  completion: '/completion.mp3',
}

// Fixed amplification applied on top of the per-play volume control. The bundled
// MP3s are mastered quietly; this multiplier makes 100% volume audibly louder
// without changing the 0-100 slider semantics.
const FIXED_GAIN = 2.0

let unlocked = false
const elements: Partial<Record<SoundKind, HTMLAudioElement>> = {}
let listenersAttached = false

let audioContext: AudioContext | null = null
let gainNode: GainNode | null = null
const mediaSources: Partial<Record<SoundKind, MediaElementAudioSourceNode>> = {}

function ensureElements(): void {
  for (const kind of Object.keys(SOUND_URLS) as SoundKind[]) {
    if (!elements[kind]) {
      const el = new Audio(SOUND_URLS[kind])
      el.preload = 'auto'
      elements[kind] = el
    }
  }
}

function ensureAudioGraph(): boolean {
  if (typeof window === 'undefined') return false
  if (!audioContext) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return false
    audioContext = new Ctx()
  }
  if (!gainNode) {
    gainNode = audioContext.createGain()
    gainNode.gain.value = FIXED_GAIN
    gainNode.connect(audioContext.destination)
  }
  // Each HTMLMediaElement can only be wrapped once; guard against re-creation.
  for (const kind of Object.keys(SOUND_URLS) as SoundKind[]) {
    const el = elements[kind]
    if (!el || mediaSources[kind]) continue
    const source = audioContext.createMediaElementSource(el)
    source.connect(gainNode)
    mediaSources[kind] = source
  }
  return true
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
  // Resume the Web Audio context from the user gesture as well.
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {
      // Best-effort; playback may still work depending on the webview.
    })
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
  // Build the Web Audio graph when supported; otherwise fall back to the
  // element's native volume control only.
  ensureAudioGraph()
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
  if (audioContext) {
    // Close is async, but for test isolation we can synchronously drop the
    // references; the old context will be garbage collected when it finishes
    // closing. We do not await here to keep the reset synchronous.
    audioContext.close().catch(() => {
      // ignore
    })
  }
  audioContext = null
  gainNode = null
  for (const kind of Object.keys(mediaSources) as SoundKind[]) {
    mediaSources[kind] = undefined
  }
}

// Test-only: unlock as if a user gesture occurred, so the post-unlock play path
// can be exercised without a real DOM gesture.
export function __unlockSoundPlayer(): void {
  unlock()
}
