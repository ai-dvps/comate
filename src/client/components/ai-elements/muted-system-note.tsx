/**
 * Locally authored primitive (no upstream AI Elements counterpart). Renders Claude
 * Code CLI wrapper-tag events — slash commands, local-command output, system
 * reminders — as muted separator-banner notes. Sits beside vendored AI Elements
 * primitives in this folder so call sites can import from a single family.
 */
'use client'

import { ChevronDownIcon, Slash } from 'lucide-react'
import { useState } from 'react'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible'
import { cn } from '../ui/utils'

import type {
  CliMetaEvent,
  LocalStderrEvent,
  LocalStdoutEvent,
  SlashCommandEvent,
} from '../../lib/cli-meta'

const PREVIEW_CHARS = 120
const ARGS_PREVIEW_CHARS = 80

export type MutedSystemNoteProps =
  | { kind: 'single'; event: CliMetaEvent }
  | {
      kind: 'paired'
      slash: SlashCommandEvent
      output: LocalStdoutEvent | LocalStderrEvent
    }

function NoteFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="note"
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
    >
      {children}
    </div>
  )
}

function SlashCommandLine({ event }: { event: SlashCommandEvent }) {
  const [expanded, setExpanded] = useState(false)
  const commandName = `/${event.name.replace(/^\//, '')}`
  const hasArgs = event.args && event.args.length > 0
  const argsPreview = hasArgs
    ? event.args.length > ARGS_PREVIEW_CHARS
      ? `${event.args.slice(0, ARGS_PREVIEW_CHARS)}…`
      : event.args
    : ''

  return (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <Slash className="size-3 text-text-tertiary flex-shrink-0" />
      <span className="font-mono text-xs text-text-secondary flex-shrink-0">
        {commandName}
      </span>
      {hasArgs && (
        <>
          <span
            className={cn(
              'text-xs text-text-tertiary min-w-0',
              expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
            )}
            title={event.args}
          >
            {expanded ? event.args : argsPreview}
          </span>
          {event.args.length > ARGS_PREVIEW_CHARS && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] text-text-tertiary hover:text-text-secondary flex-shrink-0 transition-colors"
            >
              {expanded ? 'less' : 'more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function StdoutBlock({ body }: { body: string }) {
  return (
    <div
      role="note"
      className="my-1 flex items-start gap-2 text-xs text-text-tertiary"
    >
      <span className="font-medium uppercase tracking-wide text-[10px] mt-0.5">
        stdout
      </span>
      <pre className="whitespace-pre-wrap break-words flex-1 min-w-0 font-mono">
        {body}
      </pre>
    </div>
  )
}

function StderrBlock({ body }: { body: string }) {
  return (
    <div
      role="note"
      className="my-1 flex items-start gap-2 text-xs text-text-secondary"
    >
      <span className="font-semibold uppercase tracking-wide text-[10px] mt-0.5">
        stderr
      </span>
      <pre className="whitespace-pre-wrap break-words flex-1 min-w-0 font-mono">
        {body}
      </pre>
    </div>
  )
}

function SystemReminderNote({ body }: { body: string }) {
  const [open, setOpen] = useState(false)
  const firstLine = body.split('\n')[0]
  const preview =
    firstLine.length > PREVIEW_CHARS
      ? `${body.slice(0, PREVIEW_CHARS)}…`
      : firstLine
  const hasMore = body.length > preview.length || body.includes('\n')

  return (
    <div
      role="note"
      className="my-1 text-xs text-text-tertiary"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2">
          <span className="font-medium uppercase tracking-wide text-[10px]">
            reminder
          </span>
          <span className="flex-1 min-w-0 truncate" title={firstLine}>
            {preview}
          </span>
          {hasMore && (
            <CollapsibleTrigger
              className={cn(
                'flex items-center gap-1 text-text-tertiary hover:text-text-primary transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg rounded',
              )}
            >
              <span>{open ? 'show less' : 'show more'}</span>
              <ChevronDownIcon
                className={cn(
                  'size-3 transition-transform',
                  open ? 'rotate-180' : 'rotate-0',
                )}
              />
            </CollapsibleTrigger>
          )}
        </div>
        {hasMore && (
          <CollapsibleContent className="mt-1">
            <pre className="whitespace-pre-wrap break-words text-text-secondary border-l border-border/30 pl-3">
              {body}
            </pre>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  )
}

export function MutedSystemNote(props: MutedSystemNoteProps) {
  if (props.kind === 'paired') {
    const { slash, output } = props
    const trimmedOutput = output.body.trim()
    return (
      <NoteFrame>
        <SlashCommandLine event={slash} />
        <span className="text-text-tertiary flex-shrink-0">·</span>
        <span className={cn(
          'flex-shrink-0',
          output.kind === 'local-stderr' ? 'text-text-secondary' : 'text-text-tertiary'
        )}>
          {trimmedOutput}
        </span>
      </NoteFrame>
    )
  }

  const { event } = props
  switch (event.kind) {
    case 'slash-command':
      return (
        <NoteFrame>
          <SlashCommandLine event={event} />
        </NoteFrame>
      )
    case 'local-stdout':
      return <StdoutBlock body={event.body} />
    case 'local-stderr':
      return <StderrBlock body={event.body} />
    case 'system-reminder':
      return <SystemReminderNote body={event.body} />
  }
}
