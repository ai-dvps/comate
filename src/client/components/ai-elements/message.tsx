/**
 * Adapted from Vercel AI Elements (Apache 2.0).
 * Original source: github.com/vercel/ai-elements (packages/elements/src/message.tsx)
 * Modifications:
 *  - Dropped the `MessageBranch*` family (requires shadcn `ButtonGroup` we don't vendor).
 *  - Dropped `MessageAction` (requires a shadcn `Tooltip` primitive we don't vendor).
 *  - Replaced `UIMessage["role"]` import with the local `MessageRole` shared type.
 *  - Stripped Streamdown plugin imports (`@streamdown/cjk`, `code`, `math`, `mermaid`).
 *  - Token names remapped to this repo's Tailwind palette.
 */
'use client'

import type { ComponentProps, HTMLAttributes } from 'react'
import { memo } from 'react'
import { Streamdown } from 'streamdown'

import type { MessageRole } from '../../types/message'
import { cn } from '../ui/utils'

export type { MessageRole }

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full max-w-[95%] flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className,
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      'is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-msg-user group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:text-text-primary',
      'group-[.is-assistant]:text-text-primary',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<'div'>

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props}>
    {children}
  </div>
)

export type MessageResponseProps = ComponentProps<typeof Streamdown>

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating,
)

MessageResponse.displayName = 'MessageResponse'

export type MessageToolbarProps = ComponentProps<'div'>

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      'mt-4 flex w-full items-center justify-between gap-4',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)
