/**
 * Thin local wrapper around `<Streamdown>`. No upstream AI Elements `response.tsx`
 * exists; this file exists so call sites can import a `Response` component with a
 * stable name, matching the public API the rest of the AI Elements family uses.
 */
'use client'

import type { ComponentProps } from 'react'
import { memo } from 'react'
import { Streamdown } from 'streamdown'

import { cn } from '../ui/utils'

export type ResponseProps = ComponentProps<typeof Streamdown>

export const Response = memo(({ className, ...props }: ResponseProps) => (
  <Streamdown
    className={cn(
      'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
      '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
      className,
    )}
    {...props}
  />
))

Response.displayName = 'Response'
