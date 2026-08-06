/**
 * Adapted from Vercel AI Elements (Apache 2.0).
 * Original source: github.com/vercel/ai-elements (packages/elements/src/tool.tsx)
 * Modifications:
 *  - Replaced `ToolUIPart | DynamicToolUIPart` from the `ai` package with the
 *    shared local `ToolPart` shape so we do not pull in the Vercel AI SDK.
 *  - Trimmed the `approval-*` and `output-denied` states (not used by this app).
 *  - Token names remapped to this repo's Tailwind palette; the upstream destructive
 *    background/text utility is rendered with literal red palette tokens since the
 *    repo has no destructive token.
 *  - Card is a Collapsible (Radix) that defaults to collapsed: the header stays
 *    static and a dedicated icon button at the header end toggles the body.
 *  - Expanded body is a single `max-h-[40vh] overflow-y-auto` scroll container;
 *    `forceExpanded` (search hits) opens the card one-way and scrolls the active
 *    hit into view. Search-match rings live on the Collapsible root.
 */
'use client'

import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  ShieldAlert,
  Shield,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import type { ToolPart, ToolState } from '../../types/message'
import type { SearchHighlightRange } from '../../hooks/useMessageSearch'
import { Badge } from '../ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible'
import { cn } from '../ui/utils'
import { getToolRenderer, StructuredFallback } from '../tool-renderers'
import FilePath from '../tool-renderers/FilePath'

import { CodeBlock } from './code-block'
import LinkifiedText from '../LinkifiedText'

export type { ToolPart, ToolState }

interface ToolContextValue {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
}

const ToolContext = createContext<ToolContextValue | null>(null)

const useTool = () => {
  const context = useContext(ToolContext)
  if (!context) {
    throw new Error('Tool components must be used within Tool')
  }
  return context
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  hasSearchMatch?: boolean
  isCurrentSearchMatch?: boolean
}

export const Tool = ({
  className,
  hasSearchMatch = false,
  isCurrentSearchMatch = false,
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: ToolProps) => {
  const [isOpen, setIsOpen] = useControllableState<boolean>({
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    prop: open,
  })

  const contextValue = useMemo(() => ({ isOpen, setIsOpen }), [isOpen, setIsOpen])

  return (
    <ToolContext.Provider value={contextValue}>
      <Collapsible
        className={cn(
          'not-prose mb-2 w-full rounded-md bg-surface-hover/30',
          hasSearchMatch && 'ring-1 bg-accent/5',
          hasSearchMatch && (isCurrentSearchMatch ? 'ring-accent' : 'ring-accent/30'),
          className,
        )}
        open={isOpen}
        onOpenChange={setIsOpen}
        {...props}
      >
        {children}
      </Collapsible>
    </ToolContext.Provider>
  )
}

export type ToolHeaderProps = {
  title?: string
  summary?: string
  className?: string
  autoApproved?: 'auto' | 'readonly'
  meta?: {
    displayName?: string
    iconUrl?: string
  }
} & (
  | { type: string; state: ToolState; toolName?: never }
  | { type: 'dynamic-tool'; state: ToolState; toolName: string }
)

const statusLabels: Record<ToolState, string> = {
  'input-streaming': 'Pending',
  'input-available': 'Running',
  'output-available': 'Completed',
  'output-error': 'Error',
}

const statusIcons: Record<ToolState, ReactNode> = {
  'input-streaming': <CircleIcon className="size-3" />,
  'input-available': <ClockIcon className="size-3 animate-pulse" />,
  'output-available': <CheckCircleIcon className="size-3 text-success" />,
  'output-error': <XCircleIcon className="size-3 text-destructive" />,
}

// eslint-disable-next-line react-refresh/only-export-components -- vendored helper alongside components
export const getStatusBadge = (status: ToolState) => (
  <Badge className="gap-1 rounded-full px-1.5 py-0 text-[10px]" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
)

export const ToolHeader = ({
  className,
  title,
  summary,
  type,
  state,
  toolName,
  autoApproved,
  meta,
  ...props
}: ToolHeaderProps) => {
  const { t } = useTranslation('chat')
  // Null when rendered standalone (outside a Tool); the toggle needs the
  // Collapsible context, so it only renders inside a card.
  const tool = useContext(ToolContext)
  const [iconError, setIconError] = useState(false)
  const derivedName =
    type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-')
  const displayTitle = title ?? meta?.displayName ?? derivedName

  const isUrl = summary ? /^https?:\/\//i.test(summary) : false
  const isPathLike = summary && summary.includes('/') && !isUrl
  const isDirectoryTool = derivedName === 'Glob' || derivedName === 'Grep'
  const toggleLabel = tool?.isOpen ? t('collapseToolDetails') : t('expandToolDetails')

  return (
    <div
      className={cn(
        'flex w-full items-center justify-between gap-3 p-2',
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 min-w-0">
        {meta?.iconUrl && !iconError ? (
          <img
            src={meta.iconUrl}
            alt=""
            className="size-4 flex-shrink-0 object-contain"
            onError={() => setIconError(true)}
          />
        ) : (
          <WrenchIcon className="size-4 text-text-tertiary flex-shrink-0" />
        )}
        <span className="font-medium">{displayTitle}</span>
        {summary && (
          isPathLike ? (
            <span className="max-w-[360px] min-w-0 overflow-hidden">
              <FilePath
                path={summary}
                isDirectory={isDirectoryTool}
                className="text-text-tertiary"
              />
            </span>
          ) : (
            <span
              className="text-text-tertiary truncate max-w-[360px]"
              title={summary}
            >
              {summary}
            </span>
          )
        )}
        {getStatusBadge(state)}
        {autoApproved && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[10px] font-medium',
              autoApproved === 'auto'
                ? 'bg-red-500/20 text-red-400'
                : 'bg-amber-500/20 text-amber-400',
            )}
          >
            {autoApproved === 'auto' ? (
              <ShieldAlert className="w-2.5 h-2.5" />
            ) : (
              <Shield className="w-2.5 h-2.5" />
            )}
            {t('autoApproved')}
          </span>
        )}
      </div>
      {tool && (
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={tool.isOpen}
            className="p-1 rounded-md flex-shrink-0 text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            <ChevronDownIcon
              className={cn(
                'size-4 transition-transform',
                tool.isOpen ? 'rotate-180' : 'rotate-0',
              )}
            />
          </button>
        </CollapsibleTrigger>
      )}
    </div>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent> & {
  /** One-way force expansion (search hits): opens the card, never closes it. */
  forceExpanded?: boolean
}

export const ToolContent = ({
  className,
  children,
  forceExpanded = false,
  ...props
}: ToolContentProps) => {
  const { isOpen, setIsOpen } = useTool()
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (forceExpanded) {
      setIsOpen(true)
    }
  }, [forceExpanded, setIsOpen])

  // Once force-expanded and open, bring the active search hit into view inside
  // the card's scroll container; fall back to the container body itself.
  useLayoutEffect(() => {
    if (!forceExpanded || !isOpen) return
    const container = contentRef.current
    if (!container) return
    const hit = container.querySelector('[data-search-active="true"]')
    ;(hit ?? container).scrollIntoView({ block: 'nearest' })
  }, [forceExpanded, isOpen])

  return (
    <CollapsibleContent
      ref={contentRef}
      data-tool-content=""
      className={cn('max-h-[40vh] overflow-y-auto', className)}
      {...props}
    >
      <div className="space-y-2 p-2 text-text-primary">
        {children}
      </div>
    </CollapsibleContent>
  )
}

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolPart['input']
  toolName?: string
  searchMatches?: SearchHighlightRange[]
}

export const ToolInput = ({ className, input, toolName, searchMatches, ...props }: ToolInputProps) => {
  const renderer = toolName ? getToolRenderer(toolName) : undefined
  const hasCustomRenderer = !!renderer
  const hasSearchMatch = (searchMatches?.length ?? 0) > 0
  const isCurrentSearchMatch = searchMatches?.some((r) => r.isActive) ?? false

  return (
    <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
      <h4 className="font-medium text-text-tertiary uppercase tracking-wide">
        Parameters
      </h4>
      {hasCustomRenderer ? (
        <div className="overflow-x-auto rounded-md">
          <div className="bg-surface-hover/50 px-2 py-1.5 min-w-fit">
            {renderer!(input) ?? <StructuredFallback data={input} />}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md">
          <div className="bg-surface-hover/50 min-w-fit">
            <CodeBlock
              code={JSON.stringify(input, null, 2)}
              language="json"
              hasSearchMatch={hasSearchMatch}
              isCurrentSearchMatch={isCurrentSearchMatch}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolPart['output']
  errorText: ToolPart['errorText']
  searchMatches?: SearchHighlightRange[]
}

export const ToolOutput = ({
  className,
  output,
  errorText,
  searchMatches,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null
  }

  const hasSearchMatch = (searchMatches?.length ?? 0) > 0
  const isCurrentSearchMatch = searchMatches?.some((r) => r.isActive) ?? false

  let Output = <div>{output as ReactNode}</div>

  if (typeof output === 'object' && !isValidElement(output)) {
    Output = (
      <CodeBlock
        code={JSON.stringify(output, null, 2)}
        language="json"
        hasSearchMatch={hasSearchMatch}
        isCurrentSearchMatch={isCurrentSearchMatch}
      />
    )
  } else if (typeof output === 'string') {
    Output = (
      <CodeBlock
        code={output}
        language="json"
        hasSearchMatch={hasSearchMatch}
        isCurrentSearchMatch={isCurrentSearchMatch}
      />
    )
  }

  return (
    <div className={cn('space-y-2', className)} {...props}>
      <h4 className="font-medium text-text-tertiary uppercase tracking-wide">
        {errorText ? 'Error' : 'Result'}
      </h4>
      <div className="overflow-x-auto rounded-md">
        <div
          className={cn(
            'p-2 [&_table]:w-full min-w-fit',
            errorText
              ? 'bg-destructive/20 text-destructive'
              : 'bg-surface-hover/50 text-text-primary',
          )}
        >
          {errorText && <LinkifiedText text={errorText} />}
          {Output}
        </div>
      </div>
    </div>
  )
}
