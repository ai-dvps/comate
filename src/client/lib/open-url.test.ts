import { describe, it, expect, vi, beforeEach } from 'vitest'

import { openUrlInBrowser, splitTextByUrls } from './open-url'

const invokeMock = vi.fn()
const windowOpenMock = vi.fn()
let tauriInternals: unknown = undefined

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('./tauri-api', () => ({
  isTauri: () => Boolean(tauriInternals),
}))

describe('splitTextByUrls', () => {
  it('returns the original text when no URLs are present', () => {
    expect(splitTextByUrls('hello world')).toEqual([
      { type: 'text', content: 'hello world' },
    ])
  })

  it('splits a single URL from surrounding text', () => {
    expect(splitTextByUrls('see https://example.com for details')).toEqual([
      { type: 'text', content: 'see ' },
      { type: 'url', content: 'https://example.com', href: 'https://example.com' },
      { type: 'text', content: ' for details' },
    ])
  })

  it('supports http URLs with paths and query strings', () => {
    const result = splitTextByUrls('open http://example.com/path?query=1 now')
    expect(result).toEqual([
      { type: 'text', content: 'open ' },
      { type: 'url', content: 'http://example.com/path?query=1', href: 'http://example.com/path?query=1' },
      { type: 'text', content: ' now' },
    ])
  })

  it('strips trailing punctuation from the href but keeps it in rendered text', () => {
    const result = splitTextByUrls('visit https://example.com.')
    expect(result).toEqual([
      { type: 'text', content: 'visit ' },
      { type: 'url', content: 'https://example.com.', href: 'https://example.com' },
    ])
  })

  it('handles multiple URLs in one string', () => {
    const result = splitTextByUrls('https://a.com and https://b.com')
    expect(result).toEqual([
      { type: 'url', content: 'https://a.com', href: 'https://a.com' },
      { type: 'text', content: ' and ' },
      { type: 'url', content: 'https://b.com', href: 'https://b.com' },
    ])
  })
})

describe('openUrlInBrowser', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    windowOpenMock.mockClear()
    tauriInternals = undefined
    vi.stubGlobal('open', windowOpenMock)
  })

  it('invokes the Tauri open_url command when running in Tauri', async () => {
    tauriInternals = {}
    await openUrlInBrowser('https://example.com')
    expect(invokeMock).toHaveBeenCalledWith('open_url', { url: 'https://example.com' })
    expect(windowOpenMock).not.toHaveBeenCalled()
  })

  it('falls back to window.open when not running in Tauri', async () => {
    await openUrlInBrowser('https://example.com')
    expect(windowOpenMock).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('rejects unsupported schemes without calling invoke or window.open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await openUrlInBrowser('ftp://example.com')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(windowOpenMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('catches invoke failures and logs a warning', async () => {
    tauriInternals = {}
    invokeMock.mockRejectedValueOnce(new Error('backend error'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(openUrlInBrowser('https://example.com')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
