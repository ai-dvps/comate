import { describe, it, expect } from 'vitest'
import {
  clampFontSize,
  fontSizeValue,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from './font-size'

describe('font-size', () => {
  it('formats numeric font sizes as pixel values', () => {
    expect(fontSizeValue(12)).toBe('12px')
    expect(fontSizeValue(14)).toBe('14px')
    expect(fontSizeValue(16)).toBe('16px')
  })

  it('clamps and rounds font sizes to the supported integer range', () => {
    expect(clampFontSize(MIN_FONT_SIZE - 1)).toBe(MIN_FONT_SIZE)
    expect(clampFontSize(13.6)).toBe(14)
    expect(clampFontSize(MAX_FONT_SIZE + 1)).toBe(MAX_FONT_SIZE)
  })
})
