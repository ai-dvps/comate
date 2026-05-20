import { useEffect, useMemo } from 'react'
import { AlertCircle, Bot } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import {
  detectCliMeta,
  isWrapperShape,
  pairCliMeta,
  type ViewItem,
} from '../lib/cli-meta'
import type { ChatMessage, MessagePart } from '../types/message'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './ai-elements/conversation'
import { Message, MessageContent } from './ai-elements/message'
import { MutedSystemNote } from './ai-elements/muted-system-note'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from './ai-elements/reasoning'
import CompactableText from './ai-elements/compactable-text'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from './ai-elements/tool'
import SubagentBriefStatus from './SubagentBriefStatus'
import StreamingToolInputPreview from './StreamingToolInputPreview'
import WriteToolInput from './ai-elements/write-tool'

interface MessageListProps {
  sessionId: string
  onOpenDrawer: (parentToolUseId: string) => void
}

type ToolUsePart = Extract<MessagePart, { type: 'tool_use' }>
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

const warnedShapes = new Set<string>()

function isToolResultOnly(msg: ChatMessage): boolean {
  return (
    msg.role === 'user' &&
    msg.parts.length > 0 &&
    msg.parts.every((p) => p.type === 'tool_result')
  )
}

function buildResultMap(messages: ChatMessage[]): Map<string, ToolResultPart> {
  const map = new Map<string, ToolResultPart>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_result') {
        map.set(p.toolUseId, p)
      }
    }
  }
  return map
}

function toToolState(toolUse: ToolUsePart, result?: ToolResultPart): ToolState {
  if (toolUse.state === 'streaming') return 'input-streaming'
  if (!result) return 'input-available'
  return result.isError ? 'output-error' : 'output-available'
}

export default function MessageList({ sessionId, onOpenDrawer }: MessageListProps) {
  const messages = useChatStore((s) => s.messages[sessionId] || [])
  const resultMap = useMemo(() => buildResultMap(messages), [messages])
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isToolResultOnly(m)),
    [messages],
  )
  const viewItems = useMemo(() => pairCliMeta(visibleMessages), [visibleMessages])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    for (const message of visibleMessages) {
      if (message.role !== 'user') continue
      if (message.parts.length === 0) continue
      if (!message.parts.every((p) => p.type === 'text')) continue
      const text = message.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
      if (!isWrapperShape(text)) continue
      if (detectCliMeta(text) !== null) continue
      if (warnedShapes.has(text)) continue
      warnedShapes.add(text)
      console.warn('cli-meta: unrecognized wrapper shape', {
        sample: text.slice(0, 160),
      })
    }
  }, [visibleMessages])

  if (messages.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            icon={<Bot className="w-8 h-8" />}
            title="Start a conversation"
            description="Send a message to begin chatting with Claude"
          />
        </ConversationContent>
      </Conversation>
    )
  }

  return (
    <Conversation>
      <ConversationContent className="max-w-3xl mx-auto w-full">
        {viewItems.map((item) => renderViewItem(item, resultMap, onOpenDrawer, sessionId))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

function renderViewItem(
  item: ViewItem,
  resultMap: Map<string, ToolResultPart>,
  onOpenDrawer: (parentToolUseId: string) => void,
  sessionId: string,
): React.ReactNode {
  if (item.kind === 'meta') {
    return (
      <MutedSystemNote
        key={item.messageId}
        kind="single"
        event={item.event}
      />
    )
  }
  if (item.kind === 'meta-paired') {
    return (
      <MutedSystemNote
        key={item.messageIds[0]}
        kind="paired"
        slash={item.slash}
        output={item.output}
      />
    )
  }
  return renderMessage(item.message, resultMap, onOpenDrawer, sessionId)
}

function renderMessage(
  msg: ChatMessage,
  resultMap: Map<string, ToolResultPart>,
  onOpenDrawer: (parentToolUseId: string) => void,
  sessionId: string,
): React.ReactNode {
  if (msg.role === 'system') {
    const text = msg.parts.find((p) => p.type === 'text')?.text ?? ''
    return (
      <div
        key={msg.id}
        className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[13px] text-red-300"
      >
        <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
        <span>{text}</span>
      </div>
    )
  }

  return (
    <Message from={msg.role} key={msg.id}>
      <MessageContent>
        {msg.parts.map((part, idx) => {
          const partKey = `${msg.id}-${idx}`
          if (part.type === 'text') {
            if (msg.role === 'user') {
              return (
                <p key={partKey} className="whitespace-pre-wrap">
                  {part.text}
                </p>
              )
            }
            return (
              <CompactableText key={partKey}>{part.text}</CompactableText>
            )
          }
          if (part.type === 'thinking') {
            return (
              <Reasoning
                defaultOpen={false}
                disableAutoBehavior
                isStreaming={part.state === 'streaming'}
                key={partKey}
              >
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            )
          }
          if (part.type === 'tool_use') {
            if (part.toolName === 'Agent') {
              return (
                <SubagentBriefStatus
                  key={partKey}
                  parentToolUseId={part.toolUseId}
                  sessionId={sessionId}
                  onOpenDrawer={onOpenDrawer}
                />
              )
            }
            const result = resultMap.get(part.toolUseId)
            const state = toToolState(part, result)
            const isStreaming = state === 'input-streaming'
            const streamingJson = part.inputJsonStream ?? ''
            return (
              <Tool key={partKey} defaultOpen={false}>
                <ToolHeader
                  state={state}
                  type={`tool-${part.toolName}`}
                />
                <ToolContent>
                  {isStreaming && streamingJson.length > 0 ? (
                    <StreamingToolInputPreview partialJson={streamingJson} />
                  ) : part.toolName === 'Write' ? (
                    <WriteToolInput input={part.input} />
                  ) : (
                    <ToolInput input={part.input} />
                  )}
                  {result && (
                    <ToolOutput
                      errorText={result.isError ? result.output : undefined}
                      output={result.isError ? undefined : result.output}
                    />
                  )}
                </ToolContent>
              </Tool>
            )
          }
          return null
        })}
      </MessageContent>
    </Message>
  )
}
