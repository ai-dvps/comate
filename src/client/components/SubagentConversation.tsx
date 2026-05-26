import { useEffect, useRef } from 'react'
import { WrenchIcon, TerminalIcon } from 'lucide-react'

import type { SubagentMessage, SubagentPart } from '../stores/chat-store'
import { cn } from './ui/utils'

interface SubagentConversationProps {
  messages: SubagentMessage[]
  isRunning: boolean
}

export default function SubagentConversation({
  messages,
  isRunning,
}: SubagentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isRunning) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, isRunning])

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-secondary">
        Subagent started... waiting for output
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 p-4">
      {messages.map((msg) => (
        <MessageBlock key={msg.id} message={msg} />
      ))}
    </div>
  )
}

function MessageBlock({ message }: { message: SubagentMessage }) {
  const isAssistant = message.role === 'assistant'

  return (
    <div
      className={cn(
        'flex',
        isAssistant ? 'justify-start' : 'justify-end',
      )}
    >
      <div
        className={cn(
          'max-w-[90%] rounded-lg px-3 py-2 text-sm',
          isAssistant
            ? 'bg-surface-hover/40 text-text-primary'
            : 'bg-accent/10 text-text-primary',
        )}
      >
        {message.parts.map((part, idx) => (
          <PartRenderer key={idx} part={part} />
        ))}
      </div>
    </div>
  )
}

function PartRenderer({ part }: { part: SubagentPart | undefined }) {
  if (!part) return null

  if (part.type === 'text') {
    return <p className="whitespace-pre-wrap leading-relaxed">{part.text}</p>
  }

  if (part.type === 'thinking') {
    return (
      <div className="mt-1 rounded border border-border/50 bg-surface-hover/30 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <span className="font-medium uppercase tracking-wide">Thinking</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-xs text-text-secondary leading-relaxed">
          {part.text}
        </p>
      </div>
    )
  }

  if (part.type === 'tool_use') {
    const inputStr = JSON.stringify(part.input, null, 2)
    const truncated =
      inputStr.length > 200 ? inputStr.slice(0, 200) + '…' : inputStr

    return (
      <div className="mt-1 rounded border border-border/50 bg-surface-hover/30 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <WrenchIcon className="size-3" />
          <span className="font-medium">{part.toolName}</span>
        </div>
        <pre className="mt-1 max-h-24 overflow-auto rounded bg-surface p-1.5 text-[11px] font-mono text-text-secondary">
          {truncated}
        </pre>
      </div>
    )
  }

  if (part.type === 'tool_result') {
    return (
      <div
        className={cn(
          'mt-1 rounded border px-2 py-1.5',
          part.isError
            ? 'border-destructive/20 bg-destructive/10'
            : 'border-border/50 bg-surface-hover/30',
        )}
      >
        <div className="flex items-center gap-1.5 text-xs">
          <TerminalIcon
            className={cn(
              'size-3',
              part.isError ? 'text-destructive' : 'text-text-tertiary',
            )}
          />
          <span
            className={cn(
              'font-medium',
              part.isError ? 'text-destructive' : 'text-text-tertiary',
            )}
          >
            {part.isError ? 'Error' : 'Result'}
          </span>
        </div>
        <pre
          className={cn(
            'mt-1 max-h-32 overflow-auto rounded p-1.5 text-[11px] font-mono leading-relaxed',
            part.isError
              ? 'bg-destructive/5 text-destructive'
              : 'bg-surface text-text-secondary',
          )}
        >
          {part.output}
        </pre>
      </div>
    )
  }

  return null
}
