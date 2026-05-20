import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

import { Response } from './response'

interface CompactableTextProps {
  children: string
}

const COLLAPSED_MAX_HEIGHT_PX = 384

export default function CompactableText({ children }: CompactableTextProps) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const measure = () => {
      setOverflows(el.scrollHeight > COLLAPSED_MAX_HEIGHT_PX)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(el)

    return () => {
      observer.disconnect()
    }
  }, [])

  return (
    <div className="space-y-2">
      <div
        className="overflow-hidden"
        style={{
          maxHeight: expanded ? 'none' : `${COLLAPSED_MAX_HEIGHT_PX}px`,
        }}
      >
        <div ref={contentRef}>
          <Response>{children}</Response>
        </div>
      </div>
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
  )
}
