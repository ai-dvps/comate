import { describe, it, expect } from 'vitest'
import enBrowser from '../../../i18n/en/browser.json'
import zhCNBrowser from '../../../i18n/zh-CN/browser.json'

/**
 * i18n parity (plan test scenario): the browser namespace must carry the same
 * key set in both shipped languages.
 */

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      keys.push(...flattenKeys(value as Record<string, unknown>, path))
    } else {
      keys.push(path)
    }
  }
  return keys.sort()
}

describe('browser i18n', () => {
  it('en and zh-CN carry identical key sets', () => {
    const enKeys = flattenKeys(enBrowser)
    const zhKeys = flattenKeys(zhCNBrowser)
    expect(zhKeys).toEqual(enKeys)
    // Sanity: the namespace is non-trivial (guards against both being empty).
    expect(enKeys.length).toBeGreaterThan(10)
  })

  it('no value is left empty in either language', () => {
    for (const dict of [enBrowser, zhCNBrowser]) {
      const walk = (obj: Record<string, unknown>) => {
        for (const value of Object.values(obj)) {
          if (value !== null && typeof value === 'object') {
            walk(value as Record<string, unknown>)
          } else {
            expect(typeof value).toBe('string')
            expect((value as string).trim().length).toBeGreaterThan(0)
          }
        }
      }
      walk(dict)
    }
  })
})
