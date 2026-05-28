export type FontSizePreset = 'small' | 'medium' | 'large'

export const FONT_SIZE_PRESETS: FontSizePreset[] = ['small', 'medium', 'large']

export function fontSizeClass(size: FontSizePreset): string {
  const map: Record<FontSizePreset, string> = {
    small: 'text-[11px]',
    medium: 'text-xs',
    large: 'text-sm',
  }
  return map[size]
}
