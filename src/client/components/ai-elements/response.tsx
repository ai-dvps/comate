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
      '[&_*]:[font-size:inherit]',
      '[&_h1]:text-[1.875em] [&_h2]:text-[1.5em] [&_h3]:text-[1.25em]',
      '[&_h4]:text-[1.125em] [&_h5]:text-[1em] [&_h6]:text-[0.875em]',
      className,
    )}
    {...props}
  />
))

Response.displayName = 'Response'
