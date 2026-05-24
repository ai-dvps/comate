import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Bot } from 'lucide-react'

import { useAppSettings } from '../hooks/use-app-settings'
import { fontSizeClass } from '../lib/font-size'
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
import SlashCommandMessage from './ai-elements/slash-command-message'
import VirtualizedMessageList from './VirtualizedMessageList'

const VIRTUALIZATION_THRESHOLD = 50

interface MessageListProps {
  sessionId: string
  workspaceId: string
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

function summarizeToolInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined

  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>

    // Prefer description as the summary when available — it's the human-readable intent
    if (typeof obj.description === 'string') {
      const value = obj.description
      return value.length > 120 ? value.slice(0, 120) + '…' : value
    }

    const primaryKeys = [
      'command', 'file_path', 'path', 'pattern', 'patterns', 'url', 'query',
      'prompt', 'code', 'language', 'old_string', 'new_string',
      'oldString', 'newString', 'model', 'topic', 'message',
    ]

    for (const key of primaryKeys) {
      if (obj[key] !== undefined) {
        const value = String(obj[key])
        const truncated = value.length > 120 ? value.slice(0, 120) + '…' : value

        // Try to append a short secondary field for extra context
        const secondaryKeys = ['language', 'model', 'path', 'file_path']
        for (const secKey of secondaryKeys) {
          if (secKey !== key && obj[secKey] !== undefined) {
            const secValue = String(obj[secKey])
            if (secValue.length <= 40) {
              return `${truncated} → ${secValue}`
            }
          }
        }

        return truncated
      }
    }

    // Handle short string content key separately
    if (typeof obj.content === 'string' && obj.content.length <= 120) {
      const content = obj.content
      for (const secKey of ['language', 'model', 'path', 'file_path']) {
        if (obj[secKey] !== undefined) {
          const secValue = String(obj[secKey])
          if (secValue.length <= 40) {
            return `${content} → ${secValue}`
          }
        }
      }
      return content
    }

    // Fallback: first key-value pair
    const firstKey = Object.keys(obj)[0]
    if (firstKey !== undefined) {
      const value = String(obj[firstKey])
      const truncated = value.length > 120 ? value.slice(0, 120) + '…' : value
      return `${firstKey}: ${truncated}`
    }

    const str = JSON.stringify(input)
    return str.length > 120 ? str.slice(0, 120) + '…' : str
  }

  const str = String(input)
  return str.length > 120 ? str.slice(0, 120) + '…' : str
}

function toToolState(toolUse: ToolUsePart, result?: ToolResultPart): ToolState {
  if (toolUse.state === 'streaming') return 'input-streaming'
  if (!result) return 'input-available'
  return result.isError ? 'output-error' : 'output-available'
}

export default function MessageList({ sessionId, workspaceId, onOpenDrawer }: MessageListProps) {
  const { t } = useTranslation('chat')
  const { chatFontSize } = useAppSettings()
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

  if (messages.length > VIRTUALIZATION_THRESHOLD) {
    return (
      <VirtualizedMessageList
        sessionId={sessionId}
        workspaceId={workspaceId}
        onOpenDrawer={onOpenDrawer}
      />
    )
  }

  if (messages.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            icon={<Bot className="w-8 h-8" />}
            title={t('emptyState.title')}
            description={t('emptyState.description')}
          />
        </ConversationContent>
      </Conversation>
    )
  }

  return (
    <Conversation>
      <ConversationContent className={`max-w-3xl mx-auto w-full ${fontSizeClass(chatFontSize)} [&_[data-streamdown="code-block-body"]]:[font-size:inherit] [&_[data-streamdown="code-block-body"]]:p-2 [&_[data-streamdown="inline-code"]]:[font-size:inherit]`}>
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
    if (item.event.kind === 'slash-command') {
      return (
        <SlashCommandMessage
          key={item.messageId}
          event={item.event}
          messageId={item.messageId}
        />
      )
    }
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
      <SlashCommandMessage
        key={item.messageIds[0]}
        event={item.slash}
        messageId={item.messageIds[0]}
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
        className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-destructive"
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
            if (
              part.toolName === 'TaskCreate' ||
              part.toolName === 'TaskUpdate'
            ) {
              return null
            }
            if (part.toolName === 'Agent') {
              const agentResult = resultMap.get(part.toolUseId)
              return (
                <SubagentBriefStatus
                  key={partKey}
                  parentToolUseId={part.toolUseId}
                  sessionId={sessionId}
                  onOpenDrawer={onOpenDrawer}
                  input={part.input}
                  result={agentResult}
                />
              )
            }
            const result = resultMap.get(part.toolUseId)
            const state = toToolState(part, result)
            const isStreaming = state === 'input-streaming'
            const streamingJson = part.inputJsonStream ?? ''
            const summary = summarizeToolInput(part.input)
            return (
              <Tool key={partKey}>
                <ToolHeader
                  state={state}
                  summary={summary}
                  type={`tool-${part.toolName}`}
                />
                <ToolContent>
                  {isStreaming && streamingJson.length > 0 ? (
                    <StreamingToolInputPreview partialJson={streamingJson} />
                  ) : (
                    <ToolInput input={part.input} toolName={part.toolName} />
                  )}
                  {result && (
                    <div className="pt-2">
                      <ToolOutput
                        errorText={result.isError ? result.output : undefined}
                        output={result.isError ? undefined : result.output}
                      />
                    </div>
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
