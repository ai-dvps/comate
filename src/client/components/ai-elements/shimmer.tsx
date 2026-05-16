/**
 * Adapted from Vercel AI Elements (Apache 2.0).
 * Original source: github.com/vercel/ai-elements (packages/elements/src/shimmer.tsx)
 * Modifications: replaced `motion/react` with a CSS keyframe (see `.ai-shimmer` in
 * src/client/index.css) to drop the runtime dependency on Framer Motion.
 */
'use client'

import type { CSSProperties, ElementType } from 'react'
import { memo, useMemo } from 'react'

import { cn } from '../ui/utils'

export interface TextShimmerProps {
  children: string
  as?: ElementType
  className?: string
  duration?: number
  spread?: number
}

const ShimmerComponent = ({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  )

  return (
    <Component
      className={cn('ai-shimmer relative inline-block', className)}
      style={
        {
          '--ai-shimmer-spread': `${dynamicSpread}px`,
          '--ai-shimmer-duration': `${duration}s`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  )
}

export const Shimmer = memo(ShimmerComponent)
Shimmer.displayName = 'Shimmer'
