import { describe, it, expect } from 'vitest'

import { detectStructuredReport } from './structured-report'

describe('detectStructuredReport', () => {
  it('detects a single object and computes pretty + meta', () => {
    const result = detectStructuredReport('{"a":1}')
    expect(result).not.toBeNull()
    expect(result!.meta.kind).toBe('object')
    expect(result!.meta.count).toBe(1)
    expect(result!.pretty).toBe('{\n  "a": 1\n}')
    expect(result!.meta.size).toBe(result!.pretty.length)
  })

  it('detects a single array and reports count as length', () => {
    const result = detectStructuredReport('[1,2,3]')
    expect(result).not.toBeNull()
    expect(result!.meta.kind).toBe('array')
    expect(result!.meta.count).toBe(3)
  })

  it.each(['42', '"ok"', 'null', 'true'])('rejects primitive whole-part %s', (text) => {
    expect(detectStructuredReport(text)).toBeNull()
  })

  it('rejects a fenced json block (AE2)', () => {
    expect(detectStructuredReport('```json\n{"a":1}\n```')).toBeNull()
  })

  it('rejects JSON embedded in prose (AE3)', () => {
    expect(detectStructuredReport('Here is {"x":1} — use it')).toBeNull()
  })

  it('trims surrounding whitespace and still detects', () => {
    expect(detectStructuredReport('  \n {"a":1} \n ')).not.toBeNull()
  })

  it.each(['', '   '])('returns null for empty/whitespace %s', (text) => {
    expect(detectStructuredReport(text)).toBeNull()
  })

  it.each(['{"a":', '{"a":1,}', '{a:1}'])('rejects malformed/almost-JSON %s', (text) => {
    expect(detectStructuredReport(text)).toBeNull()
  })

  it('handles emoji and reports size in UTF-16 code units', () => {
    const result = detectStructuredReport('{"x":"😀"}')
    expect(result).not.toBeNull()
    // size is defined as pretty.length (UTF-16 code units); an emoji is 2 code units.
    expect('😀'.length).toBe(2)
    expect(result!.meta.size).toBe(result!.pretty.length)
  })

  it('returns null without throwing on a large non-JSON string starting with {', () => {
    const big = '{' + 'a'.repeat(200_000)
    expect(() => detectStructuredReport(big)).not.toThrow()
    expect(detectStructuredReport(big)).toBeNull()
  })

  it('detects a large valid array and reports a large size', () => {
    const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => i))
    const result = detectStructuredReport(big)
    expect(result).not.toBeNull()
    expect(result!.meta.kind).toBe('array')
    expect(result!.meta.count).toBe(5000)
    expect(result!.meta.size).toBeGreaterThan(10_000)
  })

  it('returns null for non-string input', () => {
    expect(detectStructuredReport(42 as unknown as string)).toBeNull()
  })
})
