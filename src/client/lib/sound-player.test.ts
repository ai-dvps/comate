import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'

// Stub the browser Audio constructor before importing the module under test.
// The module is guarded against `typeof window === 'undefined'`, so importing
// it in a node:test process (no DOM) does not crash and the gesture-listener
// attach is skipped — unlock is driven via the test seam instead.
const created: MockAudio[] = []
let lastGainValue = 0
let gainNodesCreated = 0
let mediaSourcesCreated = 0
let lastConnectedTarget: unknown = null

class MockAudio {
  src: string
  preload = ''
  muted = false
  volume = 1
  currentTime = 0
  playCount = 0
  paused = false
  constructor(src: string) {
    this.src = src
    created.push(this)
  }
  play(): Promise<void> {
    this.playCount++
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
}

class MockGainNode {
  gain = {
    get value(): number {
      return lastGainValue
    },
    set value(v: number) {
      lastGainValue = v
    },
  }
  connect(target: unknown): void {
    lastConnectedTarget = target
  }
  constructor() {
    gainNodesCreated++
  }
}

class MockAudioContext {
  state = 'running'
  createGain(): MockGainNode {
    return new MockGainNode()
  }
  createMediaElementSource(): { connect: (target: unknown) => void } {
    mediaSourcesCreated++
    return {
      connect: (target: unknown) => {
        lastConnectedTarget = target
      },
    }
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const testGlobal = globalThis as unknown as Record<string, unknown>
testGlobal.Audio = MockAudio

// Provide a minimal window with Web Audio support so the gain path is exercised.
testGlobal.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  AudioContext: MockAudioContext,
}

const { playSound, isSoundUnlocked, __resetSoundPlayer, __unlockSoundPlayer } =
  await import('./sound-player')

describe('sound-player', () => {
  beforeEach(() => {
    __resetSoundPlayer()
    created.length = 0
    lastGainValue = 0
    gainNodesCreated = 0
    mediaSourcesCreated = 0
    lastConnectedTarget = null
  })

  it('is locked before any user gesture and playSound is a best-effort no-op', () => {
    assert.strictEqual(isSoundUnlocked(), false)
    // Must not throw even though no Audio elements exist yet.
    playSound('attention')
    assert.strictEqual(isSoundUnlocked(), false)
    assert.strictEqual(created.length, 0, 'no Audio elements created before unlock')
  })

  it('after unlock, plays the attention and completion clips on distinct elements', async () => {
    __unlockSoundPlayer()
    assert.strictEqual(isSoundUnlocked(), true)

    // Unlock primes both elements (silenced play); reset counts so we can
    // attribute plays to the explicit playSound calls below.
    for (const el of created) el.playCount = 0

    playSound('attention')
    playSound('completion')

    const srcs = created.map((el) => el.src).sort()
    assert.deepStrictEqual(srcs, ['/attention.mp3', '/completion.mp3'])

    const attention = created.find((el) => el.src === '/attention.mp3')
    const completion = created.find((el) => el.src === '/completion.mp3')
    assert.ok(attention && completion, 'both sound elements exist')
    assert.strictEqual(attention!.playCount, 1, 'attention played once')
    assert.strictEqual(completion!.playCount, 1, 'completion played once')
  })

  it('maps each kind to its own clip URL', async () => {
    __unlockSoundPlayer()
    assert.ok(
      created.some((el) => el.src === '/attention.mp3'),
      'attention maps to /attention.mp3',
    )
    assert.ok(
      created.some((el) => el.src === '/completion.mp3'),
      'completion maps to /completion.mp3',
    )
  })

  it('applies a 0-100 volume argument as an HTMLAudioElement 0-1 value', async () => {
    __unlockSoundPlayer()
    for (const el of created) el.playCount = 0

    playSound('attention', 50)

    const attention = created.find((el) => el.src === '/attention.mp3')
    assert.ok(attention)
    assert.strictEqual(attention!.volume, 0.5)
    assert.strictEqual(attention!.playCount, 1)
  })

  it('clamps volume above 100 to 1.0 and below 0 to 0.0', async () => {
    __unlockSoundPlayer()
    for (const el of created) el.playCount = 0

    playSound('attention', 150)
    playSound('completion', -30)

    const attention = created.find((el) => el.src === '/attention.mp3')
    const completion = created.find((el) => el.src === '/completion.mp3')
    assert.ok(attention && completion)
    assert.strictEqual(attention!.volume, 1)
    assert.strictEqual(completion!.volume, 0)
  })

  it('defaults to full volume when no volume is supplied', async () => {
    __unlockSoundPlayer()
    for (const el of created) el.playCount = 0

    playSound('attention')

    const attention = created.find((el) => el.src === '/attention.mp3')
    assert.ok(attention)
    assert.strictEqual(attention!.volume, 1)
    assert.strictEqual(attention!.playCount, 1)
  })

  it('applies a fixed Web Audio gain after unlock', async () => {
    __unlockSoundPlayer()

    playSound('attention')

    assert.strictEqual(gainNodesCreated, 1, 'one GainNode is created')
    assert.strictEqual(lastGainValue, 2, 'fixed gain is 2.0')
    assert.strictEqual(mediaSourcesCreated, 2, 'a media source is created per sound kind')
    // The last connect call should be a source -> gainNode or gainNode -> destination.
    assert.ok(lastConnectedTarget, 'audio graph is connected')
  })

  it('reuses the existing audio graph on subsequent plays', async () => {
    __unlockSoundPlayer()

    playSound('attention')
    playSound('completion')
    playSound('attention')

    assert.strictEqual(gainNodesCreated, 1, 'GainNode is created once')
    assert.strictEqual(mediaSourcesCreated, 2, 'media sources are created once per kind')
  })
})
