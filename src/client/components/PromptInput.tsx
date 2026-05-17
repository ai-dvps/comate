import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, X, Square, Loader2 } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

interface PromptInputProps {
  onSend: (content: string) => void
  onStop: () => void
  disabled?: boolean
  isStreaming?: boolean
  isInterrupting?: boolean
  hasSession?: boolean
}

export default function PromptInput({
  onSend,
  onStop,
  disabled = false,
  isStreaming = false,
  isInterrupting = false,
  hasSession = false,
}: PromptInputProps) {
  const [input, setInput] = useState('')
  const [stopPopoverOpen, setStopPopoverOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const maxHeight = Math.max(Math.round(window.innerHeight * 0.4), 160)

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [maxHeight])

  useEffect(() => {
    adjustHeight()
  }, [input, adjustHeight])

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || disabled || isStreaming || !hasSession) return
    onSend(trimmed)
    setInput('')
    textareaRef.current?.focus()
  }

  const handleClear = () => {
    setInput('')
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = input.trim().length > 0 && hasSession && !isStreaming && !disabled
  const showClear = input.length > 0

  return (
    <div className="max-w-3xl mx-auto px-4 py-4">
      <div className="relative bg-surface border border-border rounded-xl focus-within:border-border-hover transition-colors">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Claude anything about your code..."
          disabled={disabled || isStreaming}
          rows={1}
          className="w-full bg-transparent border-0 rounded-xl px-4 py-3.5 pr-24 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:ring-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words"
          style={{ minHeight: '44px', maxHeight: `${maxHeight}px` }}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          {showClear && (
            <button
              onClick={handleClear}
              disabled={isInterrupting}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary transition-colors"
              title="Clear"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          {isStreaming ? (
            <Popover open={stopPopoverOpen} onOpenChange={setStopPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  disabled={isInterrupting}
                  className="p-1.5 rounded-md text-accent hover:text-accent/80 transition-colors flex items-center gap-1"
                >
                  {isInterrupting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <span className="relative w-4 h-4 flex items-center justify-center">
                      <Loader2 className="absolute inset-0 w-4 h-4 animate-spin opacity-60" />
                      <Square className="w-2 h-2 fill-current" />
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="center"
                className="bg-surface border border-border rounded-lg shadow-lg p-3 z-50"
              >
                <p className="text-sm text-text-primary mb-3">
                  Cancel current turn?
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => setStopPopoverOpen(false)}
                    disabled={isInterrupting}
                    className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-hover transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      onStop()
                      setStopPopoverOpen(false)
                    }}
                    disabled={isInterrupting}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded-md transition-colors"
                  >
                    {isInterrupting ? (
                      <span className="flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Stopping…
                      </span>
                    ) : (
                      'Confirm'
                    )}
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="p-1.5 rounded-md text-text-tertiary hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between mt-1.5 px-1">
        <span className="text-[11px] text-text-tertiary">
          Enter to send, Shift+Enter for new line
        </span>
      </div>
    </div>
  )
}
