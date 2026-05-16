import { useMemo } from 'react'
import { AlertCircle, Bot } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import type { ChatMessage, MessagePart } from '../types/message'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './ai-elements/conversation'
import { Message, MessageContent } from './ai-elements/message'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from './ai-elements/reasoning'
import { Response } from './ai-elements/response'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from './ai-elements/tool'

interface MessageListProps {
  sessionId: string
}

type ToolUsePart = Extract<MessagePart, { type: 'tool_use' }>
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

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

export default function MessageList({ sessionId }: MessageListProps) {
  const messages = useChatStore((s) => s.messages[sessionId] || [])
  const resultMap = useMemo(() => buildResultMap(messages), [messages])
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isToolResultOnly(m)),
    [messages],
  )

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
        {visibleMessages.map((msg) => {
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
                    return <Response key={partKey}>{part.text}</Response>
                  }
                  if (part.type === 'thinking') {
                    return (
                      <Reasoning
                        isStreaming={part.state === 'streaming'}
                        key={partKey}
                      >
                        <ReasoningTrigger />
                        <ReasoningContent>{part.text}</ReasoningContent>
                      </Reasoning>
                    )
                  }
                  if (part.type === 'tool_use') {
                    const result = resultMap.get(part.toolUseId)
                    const state = toToolState(part, result)
                    return (
                      <Tool key={partKey}>
                        <ToolHeader
                          state={state}
                          type={`tool-${part.toolName}`}
                        />
                        <ToolContent>
                          <ToolInput input={part.input} />
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
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
