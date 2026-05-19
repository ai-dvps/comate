import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface StreamingToolInputPreviewProps {
  partialJson: string
}

const COLLAPSED_MAX_HEIGHT_PX = 192

export default function StreamingToolInputPreview({
  partialJson,
}: StreamingToolInputPreviewProps) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const scrollRef = useRef<HTMLPreElement>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setOverflows(el.scrollHeight > COLLAPSED_MAX_HEIGHT_PX)
  }, [partialJson])

  useEffect(() => {
    if (expanded) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [partialJson, expanded])

  return (
    <div className="space-y-2 overflow-hidden">
      <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
        Parameters (streaming…)
      </h4>
      <div className="rounded-md bg-surface-hover/50">
        <pre
          ref={scrollRef}
          className="text-[12px] leading-snug font-mono whitespace-pre-wrap break-all overflow-y-auto px-3 py-2 text-text-primary"
          style={{
            maxHeight: expanded ? 'none' : `${COLLAPSED_MAX_HEIGHT_PX}px`,
          }}
        >
          {partialJson}
        </pre>
        {overflows && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-text-tertiary hover:text-text-secondary border-t border-border hover:bg-surface-hover/30 transition-colors"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3 h-3" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="w-3 h-3" />
                Show more
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
