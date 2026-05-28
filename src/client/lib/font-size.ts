export type FontSizePreset = 'small' | 'medium' | 'large'

export const FONT_SIZE_PRESETS: FontSizePreset[] = ['small', 'medium', 'large']

export function fontSizeClass(size: FontSizePreset): string {
  const map: Record<FontSizePreset, string> = {
    small: 'text-xs',
    medium: 'text-sm',
    large: 'text-base',
  }
  return map[size]
}
