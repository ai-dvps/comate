import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Send, X, Square, Loader2, SlashSquare, Paperclip, RefreshCw, User, History } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import CommandPicker, { type CommandPickerHandle } from './CommandPicker'
import FilePicker, { type FilePickerHandle } from './FilePicker'
import HistoryPicker, { type HistoryPickerHandle } from './HistoryPicker'
import type { SlashCommandDto } from '../stores/commands-store'
import { useChatStore } from '../stores/chat-store'
import { useAppSettings } from '../hooks/use-app-settings'
import { useSentPrompts } from '../hooks/useSentPrompts'
import { shouldSubmitOnEnter } from '../lib/keyboard'
import ApprovalModeToggle from './ApprovalModeToggle'
import ProviderSelector from './ProviderSelector'

interface RefreshMeta {
  lastRefreshedAt: Date | null
  lastNewCount: number
  lastError: boolean
  isRefreshing: boolean
}

function formatRelativeDate(date: Date, t: TFunction): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t('time.justNow')
  if (diffMins < 60) return t('time.minAgo', { count: diffMins })
  if (diffHours < 24) return t('time.hourAgo', { count: diffHours })
  if (diffDays < 7) return t('time.dayAgo', { count: diffDays })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getRefreshStatusText(meta: RefreshMeta | undefined, t: TFunction): string {
  if (!meta) return ''
  if (meta.isRefreshing) return t('refreshing')
  if (!meta.lastRefreshedAt) return t('neverRefreshed')

  const timeAgo = formatRelativeDate(meta.lastRefreshedAt, t)
  if (meta.lastError) return `${timeAgo} · ${t('refreshFailed')}`
  if (meta.lastNewCount > 0) return `${timeAgo} · ${t('newMessages', { count: meta.lastNewCount })}`
  return `${timeAgo} · ${t('noNewMessages')}`
}

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
  refreshMeta?: RefreshMeta
  botName?: string
  wecomUser?: { userId: string; lastSeenAt: string | null } | null
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
  refreshMeta,
  botName,
  wecomUser,
}: PromptInputProps) {
  const { t } = useTranslation('chat')
  const { useModifierToSubmit } = useAppSettings()
  const input = useChatStore((s) =>
    sessionId ? s.drafts[sessionId] ?? '' : '',
  )
  const setDraft = useChatStore((s) => s.setDraft)
  const history = useSentPrompts(sessionId || undefined)
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
  const [slashTriggerStart, setSlashTriggerStart] = useState<number | null>(null)
  const [historyCursor, setHistoryCursor] = useState<number | null>(null)
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false)
  const [historyPickerFilter, setHistoryPickerFilter] = useState('')
  const originalDraftRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pickerHandleRef = useRef<CommandPickerHandle>(null)
  const filePickerHandleRef = useRef<FilePickerHandle>(null)
  const historyPickerHandleRef = useRef<HistoryPickerHandle>(null)
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
    setHistoryPickerOpen(false)
    setFileTriggerStart(null)
    setSlashTriggerStart(null)
    setArgumentHint(null)
    setLastInsertedCommand(null)
    setHistoryCursor(null)
    originalDraftRef.current = ''
  }, [sessionId])

  const handleInputChange = (value: string, cursorPos: number) => {
    const prev = prevInputRef.current
    prevInputRef.current = value
    setDraft(sessionId, value)

    if (value === '' && historyCursor !== null) {
      setHistoryCursor(null)
      originalDraftRef.current = ''
    }

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
      if (slashTriggerStart !== null) {
        // Cursor moved before / or / was deleted
        if (
          cursorPos <= slashTriggerStart ||
          value[slashTriggerStart] !== '/'
        ) {
          setPickerOpen(false)
          setSlashTriggerStart(null)
          return
        }
        const filterText = value.slice(slashTriggerStart + 1, cursorPos)
        if (/\s/.test(filterText)) {
          setPickerOpen(false)
          setSlashTriggerStart(null)
          return
        }
        setPickerFilter(filterText)
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

    // Detect / trigger only when no workspace picker is open
    if (!filePickerOpen && (!pickerOpen || pickerSource !== 'slash')) {
      // / as first character of empty input
      if (value === '/' && prev === '') {
        setSlashTriggerStart(0)
        setPickerSource('slash')
        setPickerFilter('')
        setPickerOpen(true)
        setFilePickerOpen(false)
        return
      }

      // / preceded by whitespace mid-text
      if (
        cursorPos > 0 &&
        value[cursorPos - 1] === '/' &&
        (cursorPos === 1 || /\s/.test(value[cursorPos - 2]))
      ) {
        setSlashTriggerStart(cursorPos - 1)
        setPickerSource('slash')
        setPickerFilter('')
        setPickerOpen(true)
        setFilePickerOpen(false)
      }
    }
  }

  const resetInput = () => {
    setDraft(sessionId, '')
    prevInputRef.current = ''
    setArgumentHint(null)
    setLastInsertedCommand(null)
    setSlashTriggerStart(null)
    setHistoryCursor(null)
    originalDraftRef.current = ''
  }

  const applyHistory = (index: number) => {
    const prompt = history[index]
    if (!prompt) return
    setDraft(sessionId, prompt)
    prevInputRef.current = prompt
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(prompt.length, prompt.length)
    })
  }

  const restoreOriginal = () => {
    const draft = originalDraftRef.current
    setDraft(sessionId, draft)
    prevInputRef.current = draft
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(draft.length, draft.length)
    })
  }

  const isRestarting = useChatStore((s) => s.isRestartingRuntime[sessionId] ?? false)

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || disabled || isStreaming || isRestarting || !hasSession) return
    onSend(trimmed)
    resetInput()
    textareaRef.current?.focus()
  }

  const handleClear = () => {
    resetInput()
    if (pickerOpen) {
      setPickerOpen(false)
      setSlashTriggerStart(null)
    }
    if (filePickerOpen) {
      setFilePickerOpen(false)
      setFileTriggerStart(null)
    }
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // History popup shortcut: Alt+H / Option+H
    if (
      e.altKey &&
      e.key.toLowerCase() === 'h' &&
      !isStreaming &&
      !isRestarting &&
      hasSession
    ) {
      e.preventDefault()
      if (historyPickerOpen) {
        setHistoryPickerOpen(false)
      } else {
        setPickerOpen(false)
        setFilePickerOpen(false)
        setFileTriggerStart(null)
        setSlashTriggerStart(null)
        setHistoryPickerFilter('')
        setHistoryPickerOpen(true)
      }
      return
    }

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
        setSlashTriggerStart(null)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        setPickerOpen(false)
        setSlashTriggerStart(null)
        return
      }
    }

    // History recall (terminal-style ArrowUp/Down) when no picker is open.
    if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      !pickerOpen &&
      !filePickerOpen &&
      !isStreaming &&
      !isRestarting
    ) {
      if (e.key === 'ArrowUp') {
        if (history.length === 0) return
        e.preventDefault()
        if (historyCursor === null) {
          originalDraftRef.current = input
          setHistoryCursor(0)
          applyHistory(0)
        } else if (historyCursor < history.length - 1) {
          const next = historyCursor + 1
          setHistoryCursor(next)
          applyHistory(next)
        }
        return
      }

      if (e.key === 'ArrowDown') {
        if (historyCursor === null) return
        e.preventDefault()
        if (historyCursor > 0) {
          const next = historyCursor - 1
          setHistoryCursor(next)
          applyHistory(next)
        } else {
          restoreOriginal()
          setHistoryCursor(null)
        }
        return
      }
    }

    if (shouldSubmitOnEnter(e, useModifierToSubmit)) {
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
    setSlashTriggerStart(null)
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

  const handleHistorySelect = (selectedPrompt: string) => {
    setDraft(sessionId, selectedPrompt)
    prevInputRef.current = selectedPrompt
    setHistoryPickerOpen(false)
    setHistoryCursor(null)
    originalDraftRef.current = ''
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(selectedPrompt.length, selectedPrompt.length)
    })
  }

  const handleCommandsClick = () => {
    if (pickerOpen) {
      setPickerOpen(false)
      setSlashTriggerStart(null)
      return
    }
    setFilePickerOpen(false)
    setHistoryPickerOpen(false)
    setFileTriggerStart(null)
    setSlashTriggerStart(null)
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
    setHistoryPickerOpen(false)
    setFilePickerSource('button')
    setFilePickerFilter('')
    setFileTriggerStart(null)
    setFilePickerOpen(true)
  }

  const handleHistoryClick = () => {
    if (historyPickerOpen) {
      setHistoryPickerOpen(false)
      return
    }
    setPickerOpen(false)
    setFilePickerOpen(false)
    setFileTriggerStart(null)
    setSlashTriggerStart(null)
    setHistoryPickerFilter('')
    setHistoryPickerOpen(true)
  }

  const canSend = input.trim().length > 0 && hasSession && !isStreaming && !isRestarting && !disabled
  const showClear = input.length > 0
  const showGhost = !!argumentHint && input === lastInsertedCommand
  const commandsDisabled = disabled || isStreaming || isRestarting
  const filesDisabled = disabled || isStreaming || isRestarting || !workspaceId
  const historyDisabled = disabled || isStreaming || isRestarting || !hasSession

  return (
    <div className={`max-w-3xl mx-auto px-4 ${isBotSession ? 'py-2' : 'py-4'}`}>
      {isBotSession ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <img src="/wecom-icon.svg" alt="WeCom" className="w-4 h-4 flex-shrink-0" />
              {botName ? (
                <span className="text-sm font-medium text-text-secondary truncate">{botName}</span>
              ) : (
                <span className="text-sm text-text-tertiary truncate">{t('notSet')}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <User className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
              <span className="text-sm text-text-secondary truncate">
                {wecomUser?.userId ?? '...'}
              </span>
              {wecomUser?.lastSeenAt && (
                <span className="text-xs text-text-tertiary flex-shrink-0">
                  · {formatRelativeDate(new Date(wecomUser.lastSeenAt), t)}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-text-tertiary truncate hidden sm:block max-w-[160px]">
              {getRefreshStatusText(refreshMeta, t)}
            </span>
            <button
              onClick={onRefresh}
              disabled={!hasSession || refreshMeta?.isRefreshing || isRestarting}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover active:bg-surface-active active:scale-[0.98] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('refresh')}
            >
              {refreshMeta?.isRefreshing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">{t('refresh')}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="relative bg-surface border border-border rounded-xl focus-within:border-border-hover transition-colors">
          <>
            <div className="flex items-center px-2 pt-2 gap-1">
              <CommandPicker
                ref={pickerHandleRef}
                workspaceId={workspaceId}
                open={pickerOpen}
                onOpenChange={(open) => {
                  setPickerOpen(open)
                  if (!open) setSlashTriggerStart(null)
                }}
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
              <HistoryPicker
                ref={historyPickerHandleRef}
                sessionId={sessionId}
                open={historyPickerOpen}
                onOpenChange={(open) => {
                  setHistoryPickerOpen(open)
                }}
                onSelect={handleHistorySelect}
                side="top"
                align="start"
                initialFilter={historyPickerFilter}
                anchor={
                  <button
                    type="button"
                    onClick={handleHistoryClick}
                    disabled={historyDisabled}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={`${t('history')} (${t('historyShortcutHint')})`}
                  >
                    <History className="w-3 h-3" />
                    <span>{t('history')}</span>
                  </button>
                }
              />
              <div className="flex-1" />
              {sessionId && !isBotSession && (
                <>
                  <ProviderSelector workspaceId={workspaceId} sessionId={sessionId} disabled={isStreaming || isRestarting} />
                  <ApprovalModeToggle workspaceId={workspaceId} sessionId={sessionId} disabled={isStreaming || isRestarting} />
                </>
              )}
            </div>
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) =>
                  handleInputChange(e.target.value, e.target.selectionStart)
                }
                onKeyDown={handleKeyDown}
                placeholder={t('placeholder')}
                disabled={disabled || isStreaming || isRestarting}
                rows={1}
                className="w-full bg-transparent border-0 px-4 py-3 text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:ring-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words"
                style={{ minHeight: '44px', maxHeight: `${maxHeight}px` }}
              />
              {showGhost && argumentHint && (
                <div
                  aria-hidden
                  className="absolute inset-0 px-4 py-3 pointer-events-none whitespace-pre-wrap break-words"
                >
                  <span className="invisible">{input}</span>
                  <span className="text-text-tertiary">{argumentHint}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end px-2 pb-2 pt-1 gap-1">
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
              ) : (
                <>
                  {useModifierToSubmit && (
                    <span className="text-[10px] text-text-tertiary select-none hidden sm:inline">
                      {/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? 'Cmd+Enter' : 'Ctrl+Enter'}
                    </span>
                  )}
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className="p-1.5 rounded-md text-text-tertiary hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={t('send')}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          </>
        </div>
      )}
    </div>
  )
}
