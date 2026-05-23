/**
 * Adapted from Vercel AI Elements (Apache 2.0).
 * Original source: github.com/vercel/ai-elements (packages/elements/src/reasoning.tsx)
 * Modifications:
 *  - Dropped the Streamdown plugin imports (`@streamdown/cjk`, `code`, `math`, `mermaid`)
 *    so we do not pull in those optional packages.
 *  - Token names remapped to this repo's Tailwind palette.
 */
'use client'

import { useControllableState } from '@radix-ui/react-use-controllable-state'
import { BrainIcon, ChevronDownIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Streamdown } from 'streamdown'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible'
import { cn } from '../ui/utils'

import { Shimmer } from './shimmer'

interface ReasoningContextValue {
  isStreaming: boolean
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  duration: number | undefined
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components -- vendored helper alongside components
export const useReasoning = () => {
  const context = useContext(ReasoningContext)
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning')
  }
  return context
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  duration?: number
  disableAutoBehavior?: boolean
}

const AUTO_CLOSE_DELAY = 1000
const MS_IN_S = 1000

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    disableAutoBehavior = false,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? (disableAutoBehavior ? false : isStreaming)
    const isExplicitlyClosed = defaultOpen === false

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    })
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    })

    const hasEverStreamedRef = useRef(isStreaming)
    const [hasAutoClosed, setHasAutoClosed] = useState(false)
    const startTimeRef = useRef<number | null>(null)

    useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now()
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S))
        startTimeRef.current = null
      }
    }, [isStreaming, setDuration])

    useEffect(() => {
      if (disableAutoBehavior) return
      if (isStreaming && !isOpen && !isExplicitlyClosed) {
        setIsOpen(true)
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed, disableAutoBehavior])

    useEffect(() => {
      if (disableAutoBehavior) return
      if (
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false)
          setHasAutoClosed(true)
        }, AUTO_CLOSE_DELAY)

        return () => clearTimeout(timer)
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed, disableAutoBehavior])

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen)
      },
      [setIsOpen],
    )

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen],
    )

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn('not-prose mb-2', className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    )
  },
)

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode
}

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking...</Shimmer>
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>
  }
  return <p>Thought for {duration} seconds</p>
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning()

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-text-tertiary text-sm transition-colors hover:text-text-primary',
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                'size-4 transition-transform',
                isOpen ? 'rotate-180' : 'rotate-0',
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    )
  },
)

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string
}

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        'mt-4 text-sm',
        'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-text-tertiary outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
        className,
      )}
      {...props}
    >
      <Streamdown className="[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">{children}</Streamdown>
    </CollapsibleContent>
  ),
)

Reasoning.displayName = 'Reasoning'
ReasoningTrigger.displayName = 'ReasoningTrigger'
ReasoningContent.displayName = 'ReasoningContent'
