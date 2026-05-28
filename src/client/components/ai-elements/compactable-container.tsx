import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'

import { cn } from '../ui/utils'

const COMPACTABLE_MAX_HEIGHT_PX = 192

export type CompactableContainerProps = ComponentProps<'div'> & {
  compactHeight?: number
  alwaysShowToggle?: boolean
}

export const CompactableContainer = ({
  className,
  children,
  compactHeight = COMPACTABLE_MAX_HEIGHT_PX,
  alwaysShowToggle = false,
  ...props
}: CompactableContainerProps) => {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const measure = () => {
      setOverflows(el.scrollHeight > compactHeight)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()

    return () => {
      observer.disconnect()
    }
  }, [compactHeight])

  return (
    <div className={cn(className)} {...props}>
      <div
        className="overflow-hidden"
        style={{
          maxHeight: expanded ? undefined : `${compactHeight}px`,
        }}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {(overflows || alwaysShowToggle) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-text-tertiary hover:text-text-secondary hover:bg-surface-hover/30 transition-colors"
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
