import { describe, it, expect } from 'vitest'
import {
  normalizePath,
  stripTrailingSlash,
  basename,
  getRelativePath,
  getPathDisplayInfo,
} from './path-utils'

describe('normalizePath', () => {
  it('replaces backslashes with forward slashes', () => {
    expect(normalizePath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx')
  })

  it('removes . segments', () => {
    expect(normalizePath('/workspace/./src/Button.tsx')).toBe('/workspace/src/Button.tsx')
  })

  it('resolves .. segments', () => {
    expect(normalizePath('/workspace/src/../Button.tsx')).toBe('/workspace/Button.tsx')
  })

  it('preserves absolute prefix', () => {
    expect(normalizePath('/workspace/src/Button.tsx')).toBe('/workspace/src/Button.tsx')
  })
})

describe('stripTrailingSlash', () => {
  it('removes trailing slashes', () => {
    expect(stripTrailingSlash('/workspace/src/')).toBe('/workspace/src')
  })

  it('keeps root as /', () => {
    expect(stripTrailingSlash('/')).toBe('/')
  })
})

describe('basename', () => {
  it('returns last segment', () => {
    expect(basename('src/components/Button.tsx')).toBe('Button.tsx')
  })

  it('returns whole string when no slash', () => {
    expect(basename('Button.tsx')).toBe('Button.tsx')
  })
})

describe('getRelativePath', () => {
  it('returns relative path inside workspace', () => {
    expect(getRelativePath('/workspace/src/Button.tsx', '/workspace')).toBe('src/Button.tsx')
  })

  it('returns . for workspace root', () => {
    expect(getRelativePath('/workspace', '/workspace')).toBe('.')
  })

  it('returns null for path outside workspace', () => {
    expect(getRelativePath('/etc/passwd', '/workspace')).toBeNull()
  })
})

describe('getPathDisplayInfo', () => {
  it('returns relative display text inside workspace', () => {
    const info = getPathDisplayInfo('/workspace/src/Button.tsx', '/workspace')
    expect(info.displayText).toBe('src/Button.tsx')
    expect(info.displayAbsolute).toBe('/workspace/src/Button.tsx')
    expect(info.relativePath).toBe('src/Button.tsx')
    expect(info.isInsideWorkspace).toBe(true)
  })

  it('returns absolute display text outside workspace', () => {
    const info = getPathDisplayInfo('/etc/passwd', '/workspace')
    expect(info.displayText).toBe('/etc/passwd')
    expect(info.relativePath).toBeNull()
    expect(info.isInsideWorkspace).toBe(false)
  })

  it('returns absolute display text when workspace is missing', () => {
    const info = getPathDisplayInfo('/workspace/src/Button.tsx')
    expect(info.displayText).toBe('/workspace/src/Button.tsx')
    expect(info.relativePath).toBeNull()
    expect(info.isInsideWorkspace).toBe(false)
  })

  it('strips trailing slashes', () => {
    const info = getPathDisplayInfo('/workspace/src/', '/workspace')
    expect(info.displayText).toBe('src')
    expect(info.displayAbsolute).toBe('/workspace/src')
  })
})
