import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, X, Square, Loader2, SlashSquare, Paperclip, RefreshCw } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import CommandPicker, { type CommandPickerHandle } from './CommandPicker'
import FilePicker, { type FilePickerHandle } from './FilePicker'
import type { SlashCommandDto } from '../stores/commands-store'
import { useChatStore } from '../stores/chat-store'

interface PromptInputProps {
  workspaceId: string
  sessionId: string
  onSend: (content: string) => void
  onStop: () => void
  onRefresh?: () => void
  disabled?: boolean
  isStreaming?: boolean
  isInterrupting?: boolean
  hasSession?: boolean
  isBotSession?: boolean
}

export default function PromptInput({
  workspaceId,
  sessionId,
  onSend,
  onStop,
  onRefresh,
  disabled = false,
  isStreaming = false,
  isInterrupting = false,
  hasSession = false,
  isBotSession = false,
}: PromptInputProps) {
  const { t } = useTranslation('chat')
  const input = useChatStore((s) =>
    sessionId ? s.drafts[sessionId] ?? '' : '',
  )
  const setDraft = useChatStore((s) => s.setDraft)
  const [stopPopoverOpen, setStopPopoverOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSource, setPickerSource] = useState<'slash' | 'button'>('slash')
  const [pickerFilter, setPickerFilter] = useState('')
  const [argumentHint, setArgumentHint] = useState<string | null>(null)
  const [lastInsertedCommand, setLastInsertedCommand] = useState<string | null>(
    null,
  )
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [filePickerSource, setFilePickerSource] = useState<'at' | 'button'>(
    'at',
  )
  const [filePickerFilter, setFilePickerFilter] = useState('')
  const [fileTriggerStart, setFileTriggerStart] = useState<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pickerHandleRef = useRef<CommandPickerHandle>(null)
  const filePickerHandleRef = useRef<FilePickerHandle>(null)
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

  useEffect(() => {
    prevInputRef.current = input
  }, [input])

  useEffect(() => {
    setPickerOpen(false)
    setFilePickerOpen(false)
    setFileTriggerStart(null)
    setArgumentHint(null)
    setLastInsertedCommand(null)
  }, [sessionId])

  const handleInputChange = (value: string, cursorPos: number) => {
    const prev = prevInputRef.current
    prevInputRef.current = value
    setDraft(sessionId, value)

    if (lastInsertedCommand && value !== lastInsertedCommand) {
      setArgumentHint(null)
      setLastInsertedCommand(null)
    }

    if (filePickerOpen) {
      if (fileTriggerStart !== null) {
        // Cursor moved before @ or @ was deleted
        if (
          cursorPos <= fileTriggerStart ||
          value[fileTriggerStart] !== '@'
        ) {
          setFilePickerOpen(false)
          setFileTriggerStart(null)
          return
        }
        const filterText = value.slice(fileTriggerStart + 1, cursorPos)
        if (/\s/.test(filterText)) {
          setFilePickerOpen(false)
          setFileTriggerStart(null)
          return
        }
        setFilePickerFilter(filterText)
      }
    }

    if (pickerOpen && pickerSource === 'slash') {
      if (value === '') {
        setPickerOpen(false)
      } else if (value.startsWith('/') && !/\s/.test(value)) {
        setPickerFilter(value.slice(1))
      } else {
        setPickerOpen(false)
      }
    }

    // Detect @ trigger only when no workspace picker is open
    if (!filePickerOpen && (!pickerOpen || pickerSource !== 'slash')) {
      // @ as first character of empty input
      if (value === '@' && prev === '') {
        setFileTriggerStart(0)
        setFilePickerSource('at')
        setFilePickerFilter('')
        setFilePickerOpen(true)
        setPickerOpen(false)
        return
      }

      // @ preceded by whitespace mid-text
      if (
        cursorPos > 0 &&
        value[cursorPos - 1] === '@' &&
        (cursorPos === 1 || /\s/.test(value[cursorPos - 2]))
      ) {
        setFileTriggerStart(cursorPos - 1)
        setFilePickerSource('at')
        setFilePickerFilter('')
        setFilePickerOpen(true)
        setPickerOpen(false)
      }
    }

    if (
      !filePickerOpen &&
      !pickerOpen &&
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
    setDraft(sessionId, '')
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
    if (filePickerOpen) setFilePickerOpen(false)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (filePickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        filePickerHandleRef.current?.moveDown()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        filePickerHandleRef.current?.moveUp()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        filePickerHandleRef.current?.commitActive()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setFilePickerOpen(false)
        setFileTriggerStart(null)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        setFilePickerOpen(false)
        setFileTriggerStart(null)
        return
      }
    }

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
    setDraft(sessionId, inserted)
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

  const handleFileSelect = (selectedPath: string) => {
    const ta = textareaRef.current
    if (!ta || fileTriggerStart === null) return
    const cursorPos = ta.selectionStart
    const before = input.slice(0, fileTriggerStart)
    const after = input.slice(cursorPos)
    const inserted = `@${selectedPath} `
    const next = before + inserted + after
    setDraft(sessionId, next)
    prevInputRef.current = next
    setFilePickerOpen(false)
    setFileTriggerStart(null)
    requestAnimationFrame(() => {
      const pos = fileTriggerStart + inserted.length
      ta.focus()
      ta.setSelectionRange(pos, pos)
    })
  }

  const handleCommandsClick = () => {
    if (pickerOpen) {
      setPickerOpen(false)
      return
    }
    setFilePickerOpen(false)
    setFileTriggerStart(null)
    setPickerSource('button')
    setPickerFilter('')
    setPickerOpen(true)
  }

  const handleFilesClick = () => {
    if (filePickerOpen) {
      setFilePickerOpen(false)
      setFileTriggerStart(null)
      return
    }
    setPickerOpen(false)
    setFilePickerSource('button')
    setFilePickerFilter('')
    setFileTriggerStart(null)
    setFilePickerOpen(true)
  }

  const canSend =
    input.trim().length > 0 && hasSession && !isStreaming && !disabled && !isBotSession
  const showClear = input.length > 0 && !isBotSession
  const showGhost = !!argumentHint && input === lastInsertedCommand
  const commandsDisabled = disabled || isStreaming || isBotSession
  const filesDisabled = disabled || isStreaming || !workspaceId || isBotSession

  return (
    <div className="max-w-3xl mx-auto px-4 py-4">
      <div className="relative bg-surface border border-border rounded-xl focus-within:border-border-hover transition-colors">
        <div className="flex items-center px-2 pt-2 gap-1">
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
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={t('commands')}
              >
                <SlashSquare className="w-3 h-3" />
                <span>{t('commands')}</span>
              </button>
            }
          />
          <FilePicker
            ref={filePickerHandleRef}
            workspaceId={workspaceId}
            open={filePickerOpen}
            onOpenChange={(open) => {
              setFilePickerOpen(open)
              if (!open) setFileTriggerStart(null)
            }}
            onSelect={handleFileSelect}
            side="top"
            align="start"
            initialFilter={filePickerFilter}
            hideFilterInput={filePickerSource === 'at'}
            refetchOnOpen
            anchor={
              <button
                type="button"
                onClick={handleFilesClick}
                disabled={filesDisabled}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={t('files')}
              >
                <Paperclip className="w-3 h-3" />
                <span>{t('files')}</span>
              </button>
            }
          />
        </div>
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) =>
              handleInputChange(e.target.value, e.target.selectionStart)
            }
            onKeyDown={handleKeyDown}
            placeholder={isBotSession ? t('botSessionPlaceholder') : t('placeholder')}
            disabled={disabled || isStreaming || isBotSession}
            title={isBotSession ? t('botSessionTooltip') : undefined}
            rows={1}
            className="w-full bg-transparent border-0 px-4 py-3 pr-24 text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:ring-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words"
            style={{ minHeight: '44px', maxHeight: `${maxHeight}px` }}
          />
          {showGhost && argumentHint && (
            <div
              aria-hidden
              className="absolute inset-0 px-4 py-3 pr-24 pointer-events-none whitespace-pre-wrap break-words"
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
              title={t('clear')}
            >
              <X className="w-4 h-4" />
            </button>
          )}
          {isStreaming ? (
            <Popover open={stopPopoverOpen} onOpenChange={setStopPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  disabled={isInterrupting}
                  className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive/80 transition-colors flex items-center gap-1.5 border border-destructive/20"
                >
                  {isInterrupting ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <span className="relative w-5 h-5 flex items-center justify-center">
                      <Loader2 className="absolute inset-0 w-5 h-5 animate-spin opacity-60" />
                      <Square className="w-2.5 h-2.5 fill-current" />
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="center"
                className="bg-surface border border-border rounded-lg shadow-lg p-3 z-50"
              >
                <p className="text-text-primary mb-3">
                  {t('stopPopover.title')}
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => setStopPopoverOpen(false)}
                    disabled={isInterrupting}
                    className="px-3 py-1.5 font-medium text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-hover transition-colors"
                  >
                    {t('stopPopover.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      onStop()
                      setStopPopoverOpen(false)
                    }}
                    disabled={isInterrupting}
                    className="px-3 py-1.5 font-medium text-accent-foreground bg-accent hover:bg-accent/90 rounded-md transition-colors"
                  >
                    {isInterrupting ? (
                      <span className="flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t('stopPopover.stopping')}
                      </span>
                    ) : (
                      t('stopPopover.confirm')
                    )}
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          ) : isBotSession ? (
            <button
              onClick={onRefresh}
              disabled={!hasSession}
              className="p-1.5 rounded-md text-text-tertiary hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('refresh')}
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="p-1.5 rounded-md text-text-tertiary hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('send')}
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
