export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 24

export function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
}

export function fontSizeValue(size: number): string {
  return `${size}px`
}
