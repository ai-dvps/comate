import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WebSocketClient } from './websocket-client'

vi.mock('./tauri-api.js', () => ({
  getWebSocketUrl: vi.fn(() => Promise.resolve('ws://test.local/ws')),
}))

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

describe('WebSocketClient queued request cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not flush a queued request after that request times out', async () => {
    const client = new WebSocketClient()
    const request = client.request('status', { workspaceId: 'ws-1' }, 10)
    const rejection = expect(request).rejects.toThrow('WebSocket request timeout: status')

    await vi.advanceTimersByTimeAsync(10)
    await rejection

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()
    socket.open()

    expect(socket.sent).toEqual([])
    client.disconnect()
  })

  it('clears disconnected queued requests before a later reconnect', async () => {
    const client = new WebSocketClient()
    const request = client.request('status', { workspaceId: 'ws-1' })
    const rejection = expect(request).rejects.toThrow('WebSocket disconnected')
    await Promise.resolve()

    client.disconnect()
    await rejection

    const reconnect = client.connect()
    await Promise.resolve()
    const socket = FakeWebSocket.instances[1]
    expect(socket).toBeDefined()
    socket.open()
    await reconnect

    expect(socket.sent).toEqual([])
    client.disconnect()
  })
})
