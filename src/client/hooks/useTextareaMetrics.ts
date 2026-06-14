import { useLayoutEffect } from 'react'

/**
 * Synchronize textarea auto-grow height and scroll position with a mirror
 * overlay in the same render commit. Using useLayoutEffect prevents a
 * one-frame flash where the overlay is taller or shorter than the textarea.
 */
export function useTextareaMetrics(
  textareaRef: React.RefObject<HTMLTextAreaElement>,
  overlayRef: React.RefObject<HTMLPreElement>,
  maxHeight: number,
  value: string,
): void {
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${nextHeight}px`

    const overlay = overlayRef.current
    if (overlay) {
      overlay.style.height = `${nextHeight}px`
      overlay.style.maxHeight = `${maxHeight}px`
      overlay.scrollTop = textarea.scrollTop
      overlay.scrollLeft = textarea.scrollLeft
    }
  }, [maxHeight, value, textareaRef, overlayRef])
}
