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
 */
'use client'

import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { isValidElement } from 'react'

import type { ToolPart, ToolState } from '../../types/message'
import { Badge } from '../ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible'
import { cn } from '../ui/utils'

import { CodeBlock } from './code-block'

export type { ToolPart, ToolState }

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn('group not-prose mb-4 w-full rounded-md border border-border', className)}
    {...props}
  />
)

export type ToolHeaderProps = {
  title?: string
  summary?: string
  className?: string
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
  'input-streaming': <CircleIcon className="size-4" />,
  'input-available': <ClockIcon className="size-4 animate-pulse" />,
  'output-available': <CheckCircleIcon className="size-4 text-green-600" />,
  'output-error': <XCircleIcon className="size-4 text-red-600" />,
}

// eslint-disable-next-line react-refresh/only-export-components -- vendored helper alongside components
export const getStatusBadge = (status: ToolState) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
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
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-')

  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full items-center justify-between gap-4 p-3',
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 min-w-0">
        <WrenchIcon className="size-4 text-text-tertiary flex-shrink-0" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {summary && (
          <span className="text-sm text-text-tertiary truncate max-w-[240px]">
            {summary}
          </span>
        )}
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-text-tertiary transition-transform group-data-[state=open]:rotate-180 flex-shrink-0" />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-text-primary outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
)

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolPart['input']
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
    <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-surface-hover/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
)

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolPart['output']
  errorText: ToolPart['errorText']
}

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null
  }

  let Output = <div>{output as ReactNode}</div>

  if (typeof output === 'object' && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    )
  } else if (typeof output === 'string') {
    Output = <CodeBlock code={output} language="json" />
  }

  return (
    <div className={cn('space-y-2', className)} {...props}>
      <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
        {errorText ? 'Error' : 'Result'}
      </h4>
      <div
        className={cn(
          'overflow-x-auto rounded-md text-xs [&_table]:w-full',
          errorText
            ? 'bg-red-900/20 text-red-400'
            : 'bg-surface-hover/50 text-text-primary',
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  )
}
