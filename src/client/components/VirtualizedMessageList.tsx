import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertCircle, ArrowDown, Bot } from 'lucide-react'

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

import { ConversationEmptyState } from './ai-elements/conversation'
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
import { Button } from './ui/button'

interface VirtualizedMessageListProps {
  sessionId: string
  workspaceId: string
  onOpenDrawer: (parentToolUseId: string) => void
}

type ToolUsePart = Extract<MessagePart, { type: 'tool_use' }>
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

const warnedShapes = new Set<string>()
const SCROLL_BOTTOM_THRESHOLD = 50
const OVERSCAN_COUNT = 5
const GAP_SIZE = 16 // gap-4 = 1rem = 16px

function getViewItemKey(item: ViewItem): string {
  if (item.kind === 'message') return item.message.id
  if (item.kind === 'meta') return item.messageId
  return item.messageIds.join('-')
}

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

const FETCH_SIZE = 50
const SCROLL_TOP_TRIGGER_THRESHOLD = 500

export default function VirtualizedMessageList({
  sessionId,
  workspaceId,
  onOpenDrawer,
}: VirtualizedMessageListProps) {
  const { t } = useTranslation('chat')
  const { chatFontSize } = useAppSettings()
  const messages = useChatStore((s) => s.messages[sessionId] || [])
  const totalMessageCount = useChatStore((s) => s.totalMessageCount[sessionId] || 0)
  const isLoadingOlder = useChatStore((s) => s.isLoadingOlderMessages[sessionId] || false)
  const fetchOlderMessages = useChatStore((s) => s.fetchOlderMessages)
  const parentRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const prevMessageCount = useRef(messages.length)
  const isFetchingRef = useRef(false)

  const resultMap = useMemo(() => buildResultMap(messages), [messages])
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isToolResultOnly(m)),
    [messages],
  )
  const viewItems = useMemo(() => pairCliMeta(visibleMessages), [visibleMessages])

  const virtualizer = useVirtualizer({
    count: viewItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: OVERSCAN_COUNT,
    gap: GAP_SIZE,
    getItemKey: (index) => {
      const item = viewItems[index]
      return item ? getViewItemKey(item) : String(index)
    },
  })

  const virtualItems = virtualizer.getVirtualItems()
  const prevViewItemsRef = useRef(viewItems)
  const anchorKeyRef = useRef<string | null>(null)

  // Detect prepend and anchor scroll position
  useEffect(() => {
    const prev = prevViewItemsRef.current
    const prevLen = prev.length
    const currLen = viewItems.length

    if (currLen > prevLen && anchorKeyRef.current !== null) {
      // Check if tail matches (indicates prepend)
      let tailMatches = true
      for (let i = 0; i < prevLen; i++) {
        if (getViewItemKey(prev[i]) !== getViewItemKey(viewItems[currLen - prevLen + i])) {
          tailMatches = false
          break
        }
      }

      if (tailMatches) {
        const newIndex = viewItems.findIndex(
          (item) => getViewItemKey(item) === anchorKeyRef.current,
        )
        if (newIndex >= 0) {
          requestAnimationFrame(() => {
            virtualizer.scrollToIndex(newIndex, { align: 'start' })
          })
        }
      }
    }

    prevViewItemsRef.current = viewItems
  }, [viewItems, virtualizer])

  // Capture first visible key before each render for potential anchoring
  useEffect(() => {
    const items = virtualizer.getVirtualItems()
    if (items.length > 0) {
      anchorKeyRef.current = String(items[0].key)
    }
  })

  // Detect scroll position for auto-scroll and scroll-to-bottom button
  useEffect(() => {
    const el = parentRef.current
    if (!el) return

    const handleScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD
      setIsAtBottom(atBottom)
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll to bottom when new messages arrive and user is at bottom
  useEffect(() => {
    if (messages.length > prevMessageCount.current && isAtBottom) {
      virtualizer.scrollToIndex(viewItems.length - 1, { align: 'end' })
    }
    prevMessageCount.current = messages.length
  }, [messages.length, isAtBottom, virtualizer, viewItems.length])

  // Scroll to bottom on initial mount if messages exist
  useEffect(() => {
    if (viewItems.length > 0) {
      virtualizer.scrollToIndex(viewItems.length - 1, { align: 'end' })
      setIsAtBottom(true)
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Detect scroll-up near top and fetch older messages
  useEffect(() => {
    const el = parentRef.current
    if (!el) return

    const handleScroll = () => {
      if (isFetchingRef.current || isLoadingOlder) return
      if (el.scrollTop > SCROLL_TOP_TRIGGER_THRESHOLD) return

      const currentWindowSize = messages.length
      const hasOlder = totalMessageCount > currentWindowSize
      if (!hasOlder) return

      const offset = Math.max(0, totalMessageCount - currentWindowSize - FETCH_SIZE)
      const limit = FETCH_SIZE

      isFetchingRef.current = true
      fetchOlderMessages(workspaceId, sessionId, offset, limit).finally(() => {
        isFetchingRef.current = false
      })
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [messages.length, totalMessageCount, isLoadingOlder, fetchOlderMessages, workspaceId, sessionId])

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

  const handleScrollToBottom = () => {
    virtualizer.scrollToIndex(viewItems.length - 1, { align: 'end' })
    setIsAtBottom(true)
  }

  if (messages.length === 0) {
    return (
      <div className="relative flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-3 max-w-3xl mx-auto w-full h-full">
          <ConversationEmptyState
            icon={<Bot className="w-8 h-8" />}
            title={t('emptyState.title')}
            description={t('emptyState.description')}
          />
        </div>
      </div>
    )
  }

  return (
    <div ref={parentRef} className="relative flex-1 overflow-y-auto">
      {isLoadingOlder && (
        <div className="p-3 max-w-3xl mx-auto w-full text-center">
          <div className="flex gap-1 justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      )}
      <div
        className={`p-3 max-w-3xl mx-auto w-full relative ${fontSizeClass(chatFontSize)}`}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualItem) => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: '0.75rem',
              right: '0.75rem',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {renderViewItem(
              viewItems[virtualItem.index],
              resultMap,
              onOpenDrawer,
              sessionId,
            )}
          </div>
        ))}
      </div>
      {!isAtBottom && (
        <Button
          className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full bg-bg hover:bg-surface-hover"
          onClick={handleScrollToBottom}
          size="icon"
          type="button"
          variant="outline"
        >
          <ArrowDown className="size-4" />
        </Button>
      )}
    </div>
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
