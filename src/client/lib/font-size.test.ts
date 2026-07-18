import { describe, it, expect } from 'vitest'
import { fontSizeClass, fontSizeValue, FONT_SIZE_PRESETS } from './font-size'

describe('font-size', () => {
  it('exports the expected presets', () => {
    expect(FONT_SIZE_PRESETS).toEqual(['small', 'medium', 'large'])
  })

  it('maps presets to Tailwind classes', () => {
    expect(fontSizeClass('small')).toBe('text-xs')
    expect(fontSizeClass('medium')).toBe('text-sm')
    expect(fontSizeClass('large')).toBe('text-base')
  })

  it('maps presets to pixel values', () => {
    expect(fontSizeValue('small')).toBe('12px')
    expect(fontSizeValue('medium')).toBe('14px')
    expect(fontSizeValue('large')).toBe('16px')
  })
})
