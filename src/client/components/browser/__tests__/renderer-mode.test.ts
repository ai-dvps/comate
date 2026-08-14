import { describe, expect, it } from 'vitest'
import { isDetachedBrowserWindow } from '../renderer-mode'

describe('detached browser renderer mode', () => {
  it('selects the minimal renderer only for the exact local mode value', () => {
    expect(isDetachedBrowserWindow('?window=detached-browser')).toBe(true)
    expect(isDetachedBrowserWindow('?window=detached-browser-extra')).toBe(false)
    expect(isDetachedBrowserWindow('?window=main')).toBe(false)
    expect(isDetachedBrowserWindow('')).toBe(false)
  })
})
