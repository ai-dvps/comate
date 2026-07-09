import { describe, it, expect } from 'vitest'

import { formatMessageTimestamp } from './format-message-timestamp'

describe('formatMessageTimestamp', () => {
  it('returns empty string for undefined timestamp', () => {
    expect(formatMessageTimestamp(undefined)).toBe('')
  })

  it('returns empty string for NaN timestamp', () => {
    expect(formatMessageTimestamp(NaN)).toBe('')
  })

  it('formats same-day timestamp as HH:mm', () => {
    const now = new Date(2026, 6, 9, 10, 0).getTime()
    const ts = new Date(2026, 6, 9, 14, 32).getTime()

    expect(formatMessageTimestamp(ts, now)).toBe('14:32')
  })

  it('formats a different-day timestamp as YYYY-MM-DD HH:mm', () => {
    const now = new Date(2026, 6, 9, 10, 0).getTime()
    const ts = new Date(2026, 6, 8, 14, 32).getTime()

    expect(formatMessageTimestamp(ts, now)).toBe('2026-07-08 14:32')
  })

  it('handles midnight boundary as different day', () => {
    const now = new Date(2026, 6, 9, 0, 1).getTime()
    const yesterday = new Date(2026, 6, 8, 23, 59).getTime()

    const formatted = formatMessageTimestamp(yesterday, now)
    expect(formatted).toBe('2026-07-08 23:59')
  })
})
