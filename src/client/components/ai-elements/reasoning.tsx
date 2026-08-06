/**
 * Adapted from Vercel AI Elements (Apache 2.0).
 * Original source: github.com/vercel/ai-elements (packages/elements/src/reasoning.tsx)
 * Modifications:
 *  - Dropped the Streamdown plugin imports (`@streamdown/cjk`, `code`, `math`, `mermaid`)
 *    so we do not pull in those optional packages.
 *  - Token names remapped to this repo's Tailwind palette.
 *  - Trigger row is static; a dedicated icon button at the row end toggles the body
 *    (same shape as the tool cards in `tool.tsx`).
 *  - Expanded body is capped at `max-h-[40vh] overflow-y-auto`; `forceOpen` (search
 *    hits) opens one-way and scrolls the active search section
 *    (`data-search-section-active`) into view inside the cap.
 */
'use client'

import { useControllableState } from '@radix-ui/react-use-controllable-state'
import i18next from 'i18next'
import { BrainIcon, ChevronDownIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
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
  forceOpen: boolean
  isCurrentSearchMatch: boolean
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
  forceOpen?: boolean
  hasSearchMatch?: boolean
  isCurrentSearchMatch?: boolean
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
    forceOpen = false,
    hasSearchMatch = false,
    isCurrentSearchMatch = false,
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
      if (forceOpen) {
        setIsOpen(true)
      }
    }, [forceOpen, setIsOpen])

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
      () => ({ duration, forceOpen, isCurrentSearchMatch, isOpen, isStreaming, setIsOpen }),
      [duration, forceOpen, isCurrentSearchMatch, isOpen, isStreaming, setIsOpen],
    )

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn(
            'not-prose mb-2 rounded-lg',
            hasSearchMatch && 'ring-1 bg-accent/5',
            hasSearchMatch && (isCurrentSearchMatch ? 'ring-accent' : 'ring-accent/30'),
            className,
          )}
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

export type ReasoningTriggerProps = ComponentProps<'div'> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode
}

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>{i18next.t('chat:thinking')}</Shimmer>
  }
  if (duration === undefined) {
    return <p>{i18next.t('chat:thoughtForSeconds')}</p>
  }
  return <p>{i18next.t('chat:thoughtForDuration', { duration })}</p>
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { t } = useTranslation('chat')
    const { isStreaming, isOpen, duration } = useReasoning()
    const toggleLabel = isOpen ? t('collapseThoughts') : t('expandThoughts')

    return (
      <div
        className={cn(
          'flex w-full items-center gap-2 text-text-tertiary transition-colors',
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(isStreaming, duration)}
          </>
        )}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={isOpen}
            className="ml-auto p-1 rounded-md flex-shrink-0 text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            <ChevronDownIcon
              className={cn(
                'size-4 transition-transform',
                isOpen ? 'rotate-180' : 'rotate-0',
              )}
            />
          </button>
        </CollapsibleTrigger>
      </div>
    )
  },
)

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string
}

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const { forceOpen, isCurrentSearchMatch, isOpen } = useReasoning()
    const contentRef = useRef<HTMLDivElement>(null)

    // Once force-opened (search hit), bring the active search section into view
    // inside the capped scroll container; fall back to an inner search mark,
    // then to the container body itself.
    useLayoutEffect(() => {
      if (!forceOpen || !isOpen) return
      const container = contentRef.current
      if (!container) return
      const target =
        container.querySelector('[data-search-section-active="true"]') ??
        container.querySelector('[data-search-active="true"]') ??
        container
      target.scrollIntoView({ block: 'nearest' })
    }, [forceOpen, isOpen])

    return (
      <CollapsibleContent
        ref={contentRef}
        data-reasoning-content=""
        data-search-section-active={isCurrentSearchMatch ? 'true' : undefined}
        className={cn(
          'mt-4 max-h-[40vh] overflow-y-auto',
          'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-text-tertiary outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
          className,
        )}
        {...props}
      >
        <Streamdown
          className="[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_*]:[font-size:inherit] [&_h1]:text-[1.875em] [&_h2]:text-[1.5em] [&_h3]:text-[1.25em] [&_h4]:text-[1.125em] [&_h5]:text-[1em] [&_h6]:text-[0.875em]"
        >
          {children}
        </Streamdown>
      </CollapsibleContent>
    )
  },
)

Reasoning.displayName = 'Reasoning'
ReasoningTrigger.displayName = 'ReasoningTrigger'
ReasoningContent.displayName = 'ReasoningContent'
