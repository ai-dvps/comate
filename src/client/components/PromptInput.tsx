import { useState, useRef, useEffect } from 'react'
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
import { useNgramCompletion } from '../hooks/useNgramCompletion'
import { shouldSubmitOnEnter } from '../lib/keyboard'
import ApprovalModeToggle from './ApprovalModeToggle'
import ProviderSelector from './ProviderSelector'
import PromptGhostText from './PromptGhostText'
import {
  extractPlainText,
  getCaretOffset,
  getSelectionOffsets,
  replaceText,
  setCaretOffset,
  setContent,
  supportsPlaintextOnly,
} from '../lib/contenteditable'

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
  botIcon?: string
  botUser?: { userId: string; lastSeenAt: string | null } | null
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
  botIcon,
  botUser,
}: PromptInputProps) {
  const { t } = useTranslation('chat')
  const { useModifierToSubmit } = useAppSettings()
  const input = useChatStore((s) =>
    sessionId ? s.drafts[sessionId] ?? '' : '',
  )
  const setDraft = useChatStore((s) => s.setDraft)
  const isRestarting = useChatStore((s) => s.isRestartingRuntime[sessionId] ?? false)
  const { suggest, train } = useNgramCompletion(workspaceId)

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
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false)
  const [historyPickerFilter, setHistoryPickerFilter] = useState('')
  const [completionSuggestion, setCompletionSuggestion] = useState<string | null>(
    null,
  )
  const [isFocused, setIsFocused] = useState(false)

  const editableRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const submitLockRef = useRef(false)
  const pickerHandleRef = useRef<CommandPickerHandle>(null)
  const filePickerHandleRef = useRef<FilePickerHandle>(null)
  const historyPickerHandleRef = useRef<HistoryPickerHandle>(null)
  const prevInputRef = useRef('')
  const undoStackRef = useRef<Array<{ value: string; caret: number }>>([])
  const redoStackRef = useRef<Array<{ value: string; caret: number }>>([])
  const undoGroupOpenRef = useRef(false)
  const undoGroupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Saved caret position when the editable surface loses focus, so pickers
  // opened by toolbar buttons can still insert at the intended position.
  const caretBeforeBlurRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (undoGroupTimerRef.current) {
        clearTimeout(undoGroupTimerRef.current)
      }
    }
  }, [])

  const maxHeight = Math.max(Math.round(window.innerHeight * 0.4), 160)

  const pushUndoState = (value: string, caret: number): void => {
    const last = undoStackRef.current[undoStackRef.current.length - 1]
    if (last && last.value === value && last.caret === caret) return
    undoStackRef.current.push({ value, caret })
    redoStackRef.current = []
  }

  const flushUndoGroup = (): void => {
    undoGroupOpenRef.current = false
    if (undoGroupTimerRef.current) {
      clearTimeout(undoGroupTimerRef.current)
      undoGroupTimerRef.current = null
    }
  }

  const openUndoGroup = (): void => {
    if (undoGroupOpenRef.current) return
    const el = editableRef.current
    if (!el) return
    pushUndoState(input, getCaretOffset(el))
    undoGroupOpenRef.current = true
  }

  const scheduleUndoGroupCommit = (): void => {
    if (undoGroupTimerRef.current) {
      clearTimeout(undoGroupTimerRef.current)
    }
    undoGroupTimerRef.current = setTimeout(() => {
      flushUndoGroup()
    }, 500)
  }
  const editableEnabled = !disabled && !isStreaming && !isRestarting
  const contentEditableMode = supportsPlaintextOnly() ? 'plaintext-only' : 'true'
  const placeholder = t('placeholder')
  const placeholderVisible = !input && !isFocused

  // Sync external draft changes (session switch, picker insert)
  // to the editable surface without disturbing active IME composition.
  useEffect(() => {
    const el = editableRef.current
    if (!el || isComposingRef.current) return
    const current = extractPlainText(el)
    if (current === input) return
    setContent(el, input)
    if (document.activeElement === el) {
      setCaretOffset(el, input.length)
    }
  }, [input])

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
    setCompletionSuggestion(null)
    undoStackRef.current = [{ value: input, caret: input.length }]
    redoStackRef.current = []
    undoGroupOpenRef.current = false
    if (undoGroupTimerRef.current) {
      clearTimeout(undoGroupTimerRef.current)
      undoGroupTimerRef.current = null
    }
  }, [sessionId])

  // Clear stuck IME composition state when the surface becomes non-editable.
  useEffect(() => {
    if (!editableEnabled) {
      isComposingRef.current = false
    }
  }, [editableEnabled])

  const handleInputChange = (
    value: string,
    cursorPos: number,
    options?: { skipInputSideEffects?: boolean },
  ) => {
    const prev = prevInputRef.current
    prevInputRef.current = value
    setDraft(sessionId, value)

    if (options?.skipInputSideEffects) return

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

    // Detect @ trigger only when no picker is open and input is not
    // disabled by streaming/restarting.
    if (
      !isStreaming &&
      !isRestarting &&
      !filePickerOpen &&
      (!pickerOpen || pickerSource !== 'slash')
    ) {
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

    // Detect / trigger only when no workspace picker is open and input is not
    // disabled by streaming/restarting.
    if (
      !isStreaming &&
      !isRestarting &&
      !filePickerOpen &&
      (!pickerOpen || pickerSource !== 'slash')
    ) {
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
    setCompletionSuggestion(null)
  }

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || disabled || isStreaming || isRestarting || !hasSession) return
    onSend(trimmed)
    train(trimmed)
    resetInput()
    editableRef.current?.focus()
  }

  const handleClear = () => {
    const el = editableRef.current
    if (el) {
      pushUndoState(input, getCaretOffset(el))
    }
    resetInput()
    if (pickerOpen) {
      setPickerOpen(false)
      setSlashTriggerStart(null)
    }
    if (filePickerOpen) {
      setFilePickerOpen(false)
      setFileTriggerStart(null)
    }
    editableRef.current?.focus()
  }

  const handleInput = () => {
    if (!isComposingRef.current && editableEnabled) {
      if (!undoGroupOpenRef.current) {
        openUndoGroup()
      }
      scheduleUndoGroupCommit()
    }
    const el = editableRef.current
    if (!el) return
    const value = extractPlainText(el)
    const cursorPos = getCaretOffset(el)
    handleInputChange(value, cursorPos, {
      skipInputSideEffects: isComposingRef.current,
    })
  }

  const handleCompositionStart = () => {
    isComposingRef.current = true
    const el = editableRef.current
    if (!el) return
    flushUndoGroup()
    pushUndoState(input, getCaretOffset(el))
  }

  const handleCompositionEnd = () => {
    isComposingRef.current = false
    const el = editableRef.current
    if (!el) return
    handleInputChange(extractPlainText(el), getCaretOffset(el))
  }

  const handleFocus = () => {
    setIsFocused(true)
  }

  const handleBlur = () => {
    setIsFocused(false)
    const el = editableRef.current
    if (!el || isComposingRef.current) return
    const value = extractPlainText(el)
    const caret = getCaretOffset(el)
    caretBeforeBlurRef.current = caret
    if (value !== input) {
      handleInputChange(value, caret)
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    const el = editableRef.current
    if (!el) return
    const [start, end] = getSelectionOffsets(el)
    pushUndoState(input, start)
    replaceText(el, text, start, end)
    handleInputChange(extractPlainText(el), getCaretOffset(el))
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.dataTransfer.getData('text/plain')
    if (!text) return
    const el = editableRef.current
    if (!el) return
    const [start, end] = getSelectionOffsets(el)
    pushUndoState(input, start)
    replaceText(el, text, start, end)
    handleInputChange(extractPlainText(el), getCaretOffset(el))
  }

  const handleBeforeInput = (e: React.FormEvent<HTMLDivElement>) => {
    const inputType = (e.nativeEvent as InputEvent).inputType
    if (
      inputType === 'insertFromPaste' ||
      inputType === 'historyUndo' ||
      inputType === 'historyRedo'
    ) {
      e.preventDefault()
      return
    }
    if (!isComposingRef.current && editableEnabled && !undoGroupOpenRef.current) {
      openUndoGroup()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = editableRef.current
    if (!el) return

    // Recover from an IME composition that was abandoned without a
    // compositionend event. This happens when the user switches IMEs
    // (e.g., Chinese -> English) mid-composition, leaving isComposingRef
    // stuck true and blocking subsequent input processing.
    if (!e.nativeEvent.isComposing && isComposingRef.current) {
      isComposingRef.current = false
    }

    // Custom undo/redo for the contentEditable surface. The browser's native
    // undo stack is unreliable here because React replaces the entire DOM on
    // every draft change, so we maintain our own history.
    const isUndo =
      (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey
    const isRedo =
      ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'z') ||
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y')
    if (isUndo || isRedo) {
      e.preventDefault()
      if (isUndo) {
        flushUndoGroup()
        if (undoStackRef.current.length === 0) return
        const current = { value: input, caret: getCaretOffset(el) }
        const previous = undoStackRef.current.pop()!
        redoStackRef.current.push(current)
        undoGroupOpenRef.current = false
        setDraft(sessionId, previous.value)
        prevInputRef.current = previous.value
        requestAnimationFrame(() => setCaretOffset(el, previous.caret))
      } else {
        flushUndoGroup()
        if (redoStackRef.current.length === 0) return
        const current = { value: input, caret: getCaretOffset(el) }
        const next = redoStackRef.current.pop()!
        undoStackRef.current.push(current)
        undoGroupOpenRef.current = false
        setDraft(sessionId, next.value)
        prevInputRef.current = next.value
        requestAnimationFrame(() => setCaretOffset(el, next.caret))
      }
      return
    }

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

    // Completion accept / dismiss when no picker is open.
    if (
      completionSuggestion &&
      !pickerOpen &&
      !filePickerOpen &&
      !historyPickerOpen
    ) {
      if (e.key === 'Tab') {
        e.preventDefault()
        const start = getCaretOffset(el)
        const before = input.slice(0, start)
        const after = input.slice(start)
        const next = before + completionSuggestion + after
        replaceText(el, next, 0, input.length)
        handleInputChange(next, start + completionSuggestion.length)
        setCompletionSuggestion(null)
        return
      }
      if (
        e.key === 'Escape' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight'
      ) {
        setCompletionSuggestion(null)
        if (e.key === 'Escape') {
          e.preventDefault()
          return
        }
      }
    }

    if (
      !isComposingRef.current &&
      shouldSubmitOnEnter(e, useModifierToSubmit)
    ) {
      e.preventDefault()
      if (submitLockRef.current) return
      submitLockRef.current = true
      handleSend()
    }
  }

  const handleKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      submitLockRef.current = false
    }
  }

  const handleCommandSelect = (command: SlashCommandDto) => {
    const el = editableRef.current
    if (!el) return
    const caret = getCaretOffset(el)
    pushUndoState(input, caret)
    const inserted = `/${command.name} `
    const start = slashTriggerStart ?? caret
    replaceText(el, inserted, start, caret)
    const value = extractPlainText(el)
    const pos = getCaretOffset(el)
    handleInputChange(value, pos)
    setLastInsertedCommand(inserted)
    setArgumentHint(command.argumentHint ?? null)
    setCompletionSuggestion(null)
    setPickerOpen(false)
    setSlashTriggerStart(null)
    el.focus()
  }

  const handleFileSelect = (selectedPath: string) => {
    const el = editableRef.current
    if (!el) return

    let start: number
    let end: number
    if (fileTriggerStart !== null) {
      // @ trigger: replace from '@' through the typed filter text.
      start = fileTriggerStart
      end = fileTriggerStart + 1 + filePickerFilter.length
    } else {
      // Button trigger: insert at the caret position saved on blur (focus
      // moves to the toolbar button before the picker opens).
      const caret = caretBeforeBlurRef.current ?? getCaretOffset(el)
      start = caret
      end = caret
    }

    pushUndoState(input, end)
    const inserted = `@${selectedPath} `
    replaceText(el, inserted, start, end)
    const value = extractPlainText(el)
    const pos = getCaretOffset(el)
    handleInputChange(value, pos)
    setCompletionSuggestion(null)
    setFilePickerOpen(false)
    setFileTriggerStart(null)
    caretBeforeBlurRef.current = null
    el.focus()
  }

  const handleHistorySelect = (selectedPrompt: string) => {
    const el = editableRef.current
    if (el) {
      pushUndoState(input, getCaretOffset(el))
    }
    setDraft(sessionId, selectedPrompt)
    prevInputRef.current = selectedPrompt
    setHistoryPickerOpen(false)
    setCompletionSuggestion(null)
    requestAnimationFrame(() => {
      const el = editableRef.current
      if (!el) return
      el.focus()
      setCaretOffset(el, selectedPrompt.length)
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

  useEffect(() => {
    if (
      !input ||
      !sessionId ||
      pickerOpen ||
      filePickerOpen ||
      historyPickerOpen ||
      isStreaming ||
      isRestarting ||
      showGhost
    ) {
      setCompletionSuggestion(null)
      return
    }
    const timer = setTimeout(() => {
      const suggestion = suggest(input)
      setCompletionSuggestion(suggestion)
    }, 300)
    return () => clearTimeout(timer)
  }, [
    input,
    sessionId,
    pickerOpen,
    filePickerOpen,
    historyPickerOpen,
    isStreaming,
    isRestarting,
    showGhost,
    suggest,
  ])

  const commandsDisabled = disabled || isStreaming || isRestarting
  const filesDisabled = disabled || isStreaming || isRestarting || !workspaceId
  const historyDisabled = disabled || isStreaming || isRestarting || !hasSession

  return (
    <div className={`max-w-3xl mx-auto px-4 ${isBotSession ? 'py-2' : 'py-4'}`}>
      {isBotSession ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              {botIcon ? (
                <img src={botIcon} alt="" className="w-4 h-4 flex-shrink-0" />
              ) : null}
              {botName ? (
                <span className="text-sm font-medium text-text-secondary truncate">{botName}</span>
              ) : (
                <span className="text-sm text-text-tertiary truncate">{t('notSet')}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <User className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
              <span className="text-sm text-text-secondary truncate">
                {botUser?.userId ?? '...'}
              </span>
              {botUser?.lastSeenAt && (
                <span className="text-xs text-text-tertiary flex-shrink-0">
                  · {formatRelativeDate(new Date(botUser.lastSeenAt), t)}
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
            <ProviderSelector
              workspaceId={workspaceId}
              sessionId={sessionId}
              disabled={isStreaming || isRestarting}
              hideNameBelowSm
            />
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
                    title={t('skills')}
                  >
                    <SlashSquare className="w-3 h-3" />
                    <span>{t('skills')}</span>
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
                workspaceId={workspaceId}
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
              {placeholderVisible && (
                <div
                  aria-hidden
                  className="absolute inset-0 z-0 px-4 py-3 text-text-tertiary pointer-events-none select-none whitespace-pre-wrap break-words"
                >
                  {placeholder}
                </div>
              )}
              <div
                ref={editableRef}
                role="textbox"
                aria-multiline="true"
                aria-placeholder={placeholder}
                aria-disabled={!editableEnabled}
                contentEditable={editableEnabled ? contentEditableMode : 'false'}
                tabIndex={editableEnabled ? 0 : -1}
                onInput={handleInput}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onBeforeInput={handleBeforeInput}
                className={`relative z-10 w-full bg-transparent border-0 px-4 py-3 text-text-primary focus:outline-none focus:ring-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words ${!editableEnabled ? 'opacity-50' : ''}`}
                style={{ minHeight: '44px', maxHeight: `${maxHeight}px` }}
              />
              <PromptGhostText
                input={input}
                argumentHint={argumentHint}
                lastInsertedCommand={lastInsertedCommand}
                completionSuggestion={completionSuggestion}
              />
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
