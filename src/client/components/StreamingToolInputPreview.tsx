import { useEffect, useLayoutEffect, useRef } from 'react'

interface StreamingToolInputPreviewProps {
  partialJson: string
}

/**
 * Distance from the bottom (px) within which pin-to-bottom follow stays (or
 * becomes) active. Scrolling further up pauses forced follow so the user can
 * read earlier stream output without being yanked back down.
 */
const FOLLOW_THRESHOLD_PX = 32

/**
 * Renders the raw streaming tool-input JSON. Height capping and scrolling are
 * owned by the surrounding tool card body (the `max-h-[40vh]` container marked
 * with `data-tool-content`); this component only follows the stream by pinning
 * that container to the bottom while the user hasn't scrolled away.
 */
export default function StreamingToolInputPreview({
  partialJson,
}: StreamingToolInputPreviewProps) {
  const preRef = useRef<HTMLPreElement>(null)
  const containerRef = useRef<Element | null>(null)
  const followRef = useRef(true)

  // The scroll container (the tool card body marked `data-tool-content`) is
  // stable for this component's lifetime — Radix unmounts the whole subtree on
  // collapse — so resolve it once and cache instead of walking per chunk.
  const resolveContainer = () => {
    if (!containerRef.current) {
      containerRef.current = preRef.current?.closest('[data-tool-content]') ?? null
    }
    return containerRef.current
  }

  useLayoutEffect(() => {
    if (!followRef.current) return
    const container = resolveContainer()
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [partialJson])

  useEffect(() => {
    const container = resolveContainer()
    if (!container) return
    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      followRef.current = distanceFromBottom <= FOLLOW_THRESHOLD_PX
    }
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <div className="space-y-2 overflow-hidden">
      <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
        Parameters (streaming…)
      </h4>
      <div className="rounded-md bg-surface-hover/50">
        <pre
          ref={preRef}
          className="text-[12px] leading-snug font-mono whitespace-pre-wrap break-all px-3 py-2 text-text-primary"
        >
          {partialJson}
        </pre>
      </div>
    </div>
  )
}
