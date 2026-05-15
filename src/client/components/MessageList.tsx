import { useChatStore } from '../stores/chat-store'
import { User, Bot, Wrench, AlertCircle } from 'lucide-react'

interface MessageListProps {
  sessionId: string
}

export default function MessageList({ sessionId }: MessageListProps) {
  const messages = useChatStore((s) => s.messages[sessionId] || [])
  const isStreaming = useChatStore((s) => s.isStreaming[sessionId])

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <Bot className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
            <p className="text-sm text-text-secondary">Start a conversation</p>
            <p className="text-xs text-text-tertiary mt-1">
              Send a message to begin chatting with Claude
            </p>
          </div>
        </div>
      )}

      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex gap-3 ${
            msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
          }`}
        >
          <div
            className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
              msg.role === 'user'
                ? 'bg-accent'
                : msg.role === 'tool'
                ? 'bg-yellow-600/30'
                : 'bg-surface-hover'
            }`}
          >
            {msg.role === 'user' && <User className="w-3.5 h-3.5 text-white" />}
            {msg.role === 'assistant' && <Bot className="w-3.5 h-3.5 text-accent" />}
            {msg.role === 'tool' && <Wrench className="w-3.5 h-3.5 text-yellow-500" />}
            {msg.role === 'system' && <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
          </div>

          <div
            className={`max-w-[80%] rounded-xl px-4 py-2.5 text-[13px] leading-relaxed ${
              msg.role === 'user'
                ? 'bg-msg-user text-text-primary'
                : msg.role === 'system'
                ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                : 'bg-surface-hover text-text-primary'
            }`}
          >
            {msg.content}
          </div>
        </div>
      ))}

      {isStreaming && (
        <div className="flex gap-3">
          <div className="w-6 h-6 rounded-full bg-surface-hover flex items-center justify-center flex-shrink-0">
            <Bot className="w-3.5 h-3.5 text-accent" />
          </div>
          <div className="bg-surface-hover rounded-xl px-4 py-2.5">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
