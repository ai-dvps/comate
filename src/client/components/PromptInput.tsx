import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, X, Square, Loader2, SlashSquare } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import CommandPicker, { type CommandPickerHandle } from './CommandPicker'
import type { SlashCommandDto } from '../stores/commands-store'

interface PromptInputProps {
  workspaceId: string
  onSend: (content: string) => void
  onStop: () => void
  disabled?: boolean
  isStreaming?: boolean
  isInterrupting?: boolean
  hasSession?: boolean
}

export default function PromptInput({
  workspaceId,
  onSend,
  onStop,
  disabled = false,
  isStreaming = false,
  isInterrupting = false,
  hasSession = false,
}: PromptInputProps) {
  const [input, setInput] = useState('')
  const [stopPopoverOpen, setStopPopoverOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSource, setPickerSource] = useState<'slash' | 'button'>('slash')
  const [pickerFilter, setPickerFilter] = useState('')
  const [argumentHint, setArgumentHint] = useState<string | null>(null)
  const [lastInsertedCommand, setLastInsertedCommand] = useState<string | null>(
    null,
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pickerHandleRef = useRef<CommandPickerHandle>(null)
  const prevInputRef = useRef('')

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

  const handleInputChange = (value: string) => {
    const prev = prevInputRef.current
    prevInputRef.current = value
    setInput(value)

    if (lastInsertedCommand && value !== lastInsertedCommand) {
      setArgumentHint(null)
      setLastInsertedCommand(null)
    }

    if (pickerOpen && pickerSource === 'slash') {
      if (value === '') {
        setPickerOpen(false)
      } else if (value.startsWith('/') && !/\s/.test(value)) {
        setPickerFilter(value.slice(1))
      } else {
        setPickerOpen(false)
      }
    } else if (
      prev === '' &&
      value.startsWith('/') &&
      !/\s/.test(value)
    ) {
      setPickerSource('slash')
      setPickerFilter(value.slice(1))
      setPickerOpen(true)
    }
  }

  const resetInput = () => {
    setInput('')
    prevInputRef.current = ''
    setArgumentHint(null)
    setLastInsertedCommand(null)
  }

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || disabled || isStreaming || !hasSession) return
    onSend(trimmed)
    resetInput()
    textareaRef.current?.focus()
  }

  const handleClear = () => {
    resetInput()
    if (pickerOpen) setPickerOpen(false)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && pickerSource === 'slash') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        pickerHandleRef.current?.moveDown()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        pickerHandleRef.current?.moveUp()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        pickerHandleRef.current?.commitActive()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPickerOpen(false)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        setPickerOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCommandSelect = (command: SlashCommandDto) => {
    const inserted = `/${command.name} `
    setInput(inserted)
    prevInputRef.current = inserted
    setLastInsertedCommand(inserted)
    setArgumentHint(command.argumentHint ?? null)
    setPickerOpen(false)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(inserted.length, inserted.length)
    })
  }

  const handleCommandsClick = () => {
    if (pickerOpen) {
      setPickerOpen(false)
      return
    }
    setPickerSource('button')
    setPickerFilter('')
    setPickerOpen(true)
  }

  const canSend =
    input.trim().length > 0 && hasSession && !isStreaming && !disabled
  const showClear = input.length > 0
  const showGhost = !!argumentHint && input === lastInsertedCommand
  const commandsDisabled = disabled || isStreaming

  return (
    <div className="max-w-3xl mx-auto px-4 py-4">
      <div className="relative bg-surface border border-border rounded-xl focus-within:border-border-hover transition-colors">
        <div className="flex items-center px-2 pt-2">
          <CommandPicker
            ref={pickerHandleRef}
            workspaceId={workspaceId}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={handleCommandSelect}
            side="top"
            align="start"
            initialFilter={pickerFilter}
            hideFilterInput={pickerSource === 'slash'}
            refetchOnOpen
            anchor={
              <button
                type="button"
                onClick={handleCommandsClick}
                disabled={commandsDisabled}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Commands"
              >
                <SlashSquare className="w-3 h-3" />
                <span>Commands</span>
              </button>
            }
          />
        </div>
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Claude anything about your code..."
            disabled={disabled || isStreaming}
            rows={1}
            className="w-full bg-transparent border-0 px-4 py-3 pr-24 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:ring-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words"
            style={{ minHeight: '44px', maxHeight: `${maxHeight}px` }}
          />
          {showGhost && argumentHint && (
            <div
              aria-hidden
              className="absolute inset-0 px-4 py-3 pr-24 text-sm pointer-events-none whitespace-pre-wrap break-words"
            >
              <span className="invisible">{input}</span>
              <span className="text-text-tertiary">{argumentHint}</span>
            </div>
          )}
        </div>
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
