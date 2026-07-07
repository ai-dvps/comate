import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'

import { useAppSettings } from '../hooks/use-app-settings'
import { fontSizeClass } from '../lib/font-size'
import { useChatStore } from '../stores/chat-store'
import {
  detectCliMeta,
  isWrapperShape,
  pairCliMeta,
  type ViewItem,
} from '../lib/cli-meta'
import type { ChatMessage } from '../types/message'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './ai-elements/conversation'
import { MutedSystemNote } from './ai-elements/muted-system-note'
import SlashCommandMessage from './ai-elements/slash-command-message'
import VirtualizedMessageList from './VirtualizedMessageList'
import ChatMessageRenderer, { CompactBoundary } from './ChatMessageRenderer'
import { adaptChatMessage, buildResultMap } from './chat-message-adapter'
import CompactingIndicator from './CompactingIndicator'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'

const EMPTY_ARRAY: [] = []

const VIRTUALIZATION_THRESHOLD = 50

interface MessageListProps {
  sessionId: string
  workspaceId: string
  onOpenDrawer: (parentToolUseId: string) => void
  onOpenWorkflow?: (runId: string) => void
  isVisible?: boolean
  searchMatches?: MessageSearchMatch[]
  currentMatch?: MessageSearchMatch | null
}

const warnedShapes = new Set<string>()

function isToolResultOnly(msg: ChatMessage): boolean {
  return (
    msg.role === 'user' &&
    msg.parts.length > 0 &&
    msg.parts.every((p) => p?.type === 'tool_result')
  )
}

export default function MessageList({ sessionId, workspaceId, onOpenDrawer, onOpenWorkflow, isVisible = true, searchMatches = [], currentMatch = null }: MessageListProps) {
  const { t } = useTranslation('chat')
  const { chatFontSize } = useAppSettings()
  const messages = useChatStore((s) => s.messages[sessionId] ?? EMPTY_ARRAY)
  const autoApprovedTools = useChatStore((s) => s.autoApprovedTools[sessionId])
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
      if (!message.parts.every((p) => p?.type === 'text')) continue
      const text = message.parts
        .map((p) => (p?.type === 'text' ? p.text : ''))
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

  useEffect(() => {
    if (!currentMatch) return
    const el = document.querySelector('[data-search-active="true"]')
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [currentMatch])

  if (messages.length > VIRTUALIZATION_THRESHOLD) {
    return (
      <VirtualizedMessageList
        sessionId={sessionId}
        workspaceId={workspaceId}
        onOpenDrawer={onOpenDrawer}
        onOpenWorkflow={onOpenWorkflow}
        isVisible={isVisible}
        searchMatches={searchMatches}
        currentMatch={currentMatch}
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
      <ConversationContent className={`max-w-3xl mx-auto w-full ${fontSizeClass(chatFontSize)}`}>
        {viewItems.map((item) => renderViewItem(item, resultMap, onOpenDrawer, onOpenWorkflow, sessionId, autoApprovedTools, searchMatches, currentMatch))}
        <CompactingIndicator sessionId={sessionId} />
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

function renderViewItem(
  item: ViewItem,
  resultMap: Map<string, Extract<import('./ChatMessageRenderer').RenderablePart, { type: 'tool_result' }>>,
  onOpenDrawer: (parentToolUseId: string) => void,
  onOpenWorkflow: ((runId: string) => void) | undefined,
  sessionId: string,
  autoApprovedTools?: Record<string, 'auto' | 'readonly'>,
  searchMatches?: MessageSearchMatch[],
  currentMatch?: MessageSearchMatch | null,
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

  const adapted = adaptChatMessage(item.message)

  if (adapted.role === 'system') {
    if (item.message.isCompactBoundary) {
      return <CompactBoundary key={adapted.id} />
    }
  }

  return (
    <ChatMessageRenderer
      key={adapted.id}
      message={adapted}
      resultMap={resultMap}
      onOpenDrawer={onOpenDrawer}
      onOpenWorkflow={onOpenWorkflow}
      sessionId={sessionId}
      autoApprovedTools={autoApprovedTools}
      searchMatches={searchMatches}
      currentMatch={currentMatch}
    />
  )
}
