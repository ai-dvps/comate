import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Activity, ArrowUp, X, Square, Loader2, RefreshCw, User, History, ImagePlus } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import CommandPicker, { type CommandPickerHandle } from './CommandPicker'
import FilePicker, { type FilePickerHandle } from './FilePicker'
import HistoryPicker, { type HistoryPickerHandle } from './HistoryPicker'
import { useCommands, type SlashCommandDto } from '../stores/commands-store'
import {
  newChatDraftSessionId,
  promptImageDraftKey,
  useChatStore,
  type ApprovalMode,
  type PromptTurnDraft,
} from '../stores/chat-store'
import { useAppSettings } from '../hooks/use-app-settings'
import { usePromptReferenceValidation } from '../hooks/usePromptReferenceValidation'
import { shouldSubmitOnEnter } from '../lib/keyboard'
import ApprovalModeToggle from './ApprovalModeToggle'
import FastModeToggle from './FastModeToggle'
import ProviderSelector from './ProviderSelector'
import BackendSelector from './BackendSelector'
import { useBackendStore, backendAvailability, backendCapability, type BackendId } from '../stores/backend-store'
import { useProviderStore } from '../stores/provider-store'
import { resolveImageInputProfile } from '@server/utils/image-input-profile'
import {
  ImageInputError,
  normalizeImageBatch,
  releasePromptImage,
} from '../lib/image-input'
import PromptImageRail from './PromptImageRail'
import PromptGhostText from './PromptGhostText'
import {
  extractPlainText,
  getCaretOffset,
  getSelectionAnchorFocusOffsets,
  getSelectionOffsets,
  getSelectionPlainText,
  replaceText,
  setCaretOffset,
  setSelectionOffsets,
} from '../lib/contenteditable'
import {
  getPromptReferenceDeletionRange,
  projectPromptReferenceChips,
} from '../lib/prompt-reference-chips'
import {
  cloneCommittedReferences,
  commitValidatedReferences,
  type CommittedPromptReference,
  type PromptReferenceCommitSource,
  rebaseCommittedReferences,
  reconcileCommittedReferenceStatuses,
  restoreCommittedReferences,
  sameCommittedReferences,
} from '../lib/prompt-reference-state'
import type { ValidatedPromptReference } from '../lib/prompt-references'

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

function getBackgroundTaskTypeLabel(type: string, t: TFunction): string {
  const normalized = type.toLowerCase()
  if (normalized.includes('agent')) return t('activity.taskType.agent')
  if (normalized.includes('bash') || normalized.includes('command')) return t('activity.taskType.command')
  if (normalized.includes('workflow')) return t('activity.taskType.workflow')
  return t('activity.taskType.background')
}

const TOOLBAR_BREAKPOINTS = [
  { width: 680, hidden: [] as string[] },
  { width: 440, hidden: ['history'] },
  { width: 380, hidden: ['history', 'provider'] },
  { width: 330, hidden: ['history', 'provider', 'fast'] },
  { width: 280, hidden: ['history', 'provider', 'fast', 'approval'] },
  { width: 220, hidden: ['history', 'provider', 'fast', 'approval', 'clear'] },
]

function getToolbarVisibility(width: number | undefined) {
  const hidden = new Set(
    width === undefined
      ? []
      : (TOOLBAR_BREAKPOINTS.find((b) => width >= b.width)?.hidden ??
          TOOLBAR_BREAKPOINTS[TOOLBAR_BREAKPOINTS.length - 1].hidden),
  )
  return {
    showHistory: !hidden.has('history'),
    showProvider: !hidden.has('provider'),
    showFast: !hidden.has('fast'),
    showApproval: !hidden.has('approval'),
    showClear: !hidden.has('clear'),
  }
}

function getBackgroundTaskStopKey(sessionId: string, taskId: string): string {
  return JSON.stringify([sessionId, taskId])
}

interface PromptInputCommonProps {
  workspaceId: string
  onSend: (turn: PromptTurnDraft) => void
  disabled?: boolean
}

interface SessionPromptInputProps extends PromptInputCommonProps {
  mode?: 'session'
  sessionId: string
  onStop: () => void
  onRefresh?: () => void
  isStreaming?: boolean
  isInterrupting?: boolean
  hasSession?: boolean
  isBotSession?: boolean
  refreshMeta?: RefreshMeta
  botName?: string
  botIcon?: string
  botUser?: { userId: string; lastSeenAt: string | null } | null
}

interface NewChatPromptInputProps extends PromptInputCommonProps {
  mode: 'new-chat'
  backendId: BackendId | null
  onBackendChange: (backendId: BackendId) => void
  providerId: string | null
  onProviderChange: (providerId: string | null) => void
  codexModel?: string | null
  codexEffort?: string | null
  codexSpeed?: string | null
  onCodexSettingsChange?: (settings: {
    codexModel: string | null
    codexEffort: string | null
    codexSpeed: string | null
  }) => void
  fastMode: boolean
  onFastModeChange: (fastMode: boolean) => void
  approvalMode: ApprovalMode
  onApprovalModeChange: (approvalMode: ApprovalMode) => void
}

type PromptInputProps = SessionPromptInputProps | NewChatPromptInputProps

interface PromptUndoSnapshot {
  value: string
  caret: number
  references: CommittedPromptReference[]
}

interface PendingReferenceCommit {
  source: PromptReferenceCommitSource
}

function chipProjectionMatches(
  element: HTMLElement,
  input: string,
  references: CommittedPromptReference[],
): boolean {
  if (extractPlainText(element) !== input) return false
  const chips = Array.from(
    element.querySelectorAll<HTMLElement>('[data-prompt-reference-chip]'),
  )
  return (
    chips.length === references.length &&
    chips.every((chip, index) => {
      const reference = references[index]
      return (
        chip.dataset.referenceId === reference.id &&
        chip.dataset.referenceText === reference.text &&
        chip.dataset.referenceStatus === reference.status
      )
    })
  )
}

export default function PromptInput(props: PromptInputProps) {
  const isNewChat = props.mode === 'new-chat'
  const workspaceId = props.workspaceId
  const sessionId = isNewChat ? newChatDraftSessionId(workspaceId) : props.sessionId
  const commandSessionId = isNewChat ? undefined : props.sessionId
  const onSend = props.onSend
  const onStop = isNewChat ? undefined : props.onStop
  const onRefresh = isNewChat ? undefined : props.onRefresh
  const disabled = props.disabled ?? false
  const isStreaming = isNewChat ? false : props.isStreaming ?? false
  const isInterrupting = isNewChat ? false : props.isInterrupting ?? false
  const hasSession = isNewChat ? false : props.hasSession ?? false
  const isBotSession = isNewChat ? false : props.isBotSession ?? false
  const refreshMeta = isNewChat ? undefined : props.refreshMeta
  const botName = isNewChat ? undefined : props.botName
  const botIcon = isNewChat ? undefined : props.botIcon
  const botUser = isNewChat ? undefined : props.botUser
  const { t } = useTranslation('chat')
  const { useModifierToSubmit } = useAppSettings()
  const input = useChatStore((s) =>
    sessionId ? s.drafts[sessionId] ?? '' : '',
  )
  const setDraft = useChatStore((s) => s.setDraft)
  const imageDraftKey = promptImageDraftKey(workspaceId, sessionId)
  const images = useChatStore((s) => s.imageDrafts?.[imageDraftKey] ?? [])
  const hasPendingTurn = useChatStore((s) => Boolean(s.pendingTurns?.[sessionId]))
  const setImageDrafts = useChatStore((s) => s.setImageDrafts)
  const stopBackgroundTask = useChatStore((s) => s.stopBackgroundTask)
  const isRestarting = useChatStore((s) => isNewChat ? false : s.isRestartingRuntime[sessionId] ?? false)
  const activity = useChatStore((s) => isNewChat ? undefined : s.sessionActivity[sessionId])
  const session = useChatStore((s) => isNewChat
    ? undefined
    : s.sessions[workspaceId]?.find((item) => item.id === sessionId))
  const sessionBackend = session?.backend as BackendId | undefined
  const backends = useBackendStore((s) => s.backends)
  const defaultBackend = useBackendStore((s) => s.defaultBackend)
  const activeBackend = (isNewChat ? props.backendId : sessionBackend) ?? defaultBackend ?? 'claude'
  const backgroundTasks = activity?.backgroundTasks ?? []
  const backgroundTaskCount = backgroundTasks.length
  const isForegroundActive = isStreaming && activity?.phase !== 'background'
  const isComposerLocked = (isForegroundActive && !hasPendingTurn) || isInterrupting
  const {
    commands,
    loading: commandsLoading,
    error: commandsError,
    fetch: fetchCommands,
    refresh: refreshCommands,
  } = useCommands(workspaceId, {
    sessionId: commandSessionId,
    backendId: activeBackend,
  })
  const { candidates, refresh: refreshReferences } =
    usePromptReferenceValidation({
      workspaceId,
      input,
      commands,
      commandsLoading,
      commandsError,
    })

  useEffect(() => {
    void fetchCommands()
  }, [fetchCommands])

  const [stopPopoverOpen, setStopPopoverOpen] = useState(false)
  const [stoppingBackgroundTaskIds, setStoppingBackgroundTaskIds] = useState<Set<string>>(
    () => new Set(),
  )
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
  const [isFocused, setIsFocused] = useState(false)
  const [committedReferences, setCommittedReferencesState] = useState<
    CommittedPromptReference[]
  >([])
  const [imageBusyKeys, setImageBusyKeys] = useState<Set<string>>(() => new Set())
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({})
  const [referenceTooltip, setReferenceTooltip] = useState<{
    text: string
    left: number
    top: number
    above: boolean
  } | null>(null)

  const editableRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const submitLockRef = useRef(false)
  const sendInFlightRef = useRef(false)
  const pickerHandleRef = useRef<CommandPickerHandle>(null)
  const filePickerHandleRef = useRef<FilePickerHandle>(null)
  const historyPickerHandleRef = useRef<HistoryPickerHandle>(null)
  const imageFileInputRef = useRef<HTMLInputElement>(null)
  const imageIntakeKeysRef = useRef<Set<string>>(new Set())
  const imageIntakeRevisionsRef = useRef<Map<string, number>>(new Map())
  const imageComposerDisposedRef = useRef(false)
  const prevInputRef = useRef('')
  const referenceDraftSourceRef = useRef<string>()
  const committedReferencesRef = useRef<CommittedPromptReference[]>([])
  const pendingReferenceCommitRef = useRef<PendingReferenceCommit | null>(null)
  const undoStackRef = useRef<PromptUndoSnapshot[]>([])
  const redoStackRef = useRef<PromptUndoSnapshot[]>([])
  const undoGroupOpenRef = useRef(false)
  const undoGroupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Saved caret position when the editable surface loses focus, so pickers
  // opened by toolbar buttons can still insert at the intended position.
  const caretBeforeBlurRef = useRef<number | null>(null)
  const inputCardRef = useRef<HTMLDivElement>(null)
  const [contentWidth, setContentWidth] = useState<number | undefined>(undefined)

  // Mirror BackendSelector's effective-backend resolution (U5/R4): a new chat
  // or draft without a locked backend runs on the app-level default backend,
  // so capability gates must evaluate against that backend rather than the raw
  // unset value — otherwise image intake is wrongly disabled with
  // 'backend.capabilityUndeclared' even though the session will run on a
  // fully-capable backend.
  const activeProviderId = isNewChat ? props.providerId : session?.providerId ?? null
  const fetchBackends = useBackendStore((s) => s.fetchBackends)
  const providers = useProviderStore((s) => s.providers)
  const fetchProviders = useProviderStore((s) => s.fetchProviders)
  const activeProvider = activeProviderId
    ? providers.find((provider) => provider.id === activeProviderId)
    : providers.find((provider) => provider.isDefault)
  const imageBackendCapability = backendCapability(backends, activeBackend, 'imageInput')
  const normalizedActiveBackend = activeBackend === 'claude' || activeBackend === 'opencode'
    ? activeBackend
    : null
  const imageProfile = normalizedActiveBackend
    ? resolveImageInputProfile(normalizedActiveBackend, activeProvider?.model)
    : null
  const imageInputAvailable =
    !isBotSession &&
    imageBackendCapability.state === 'full' &&
    imageProfile?.enabled === true
  const imageUnsupportedReasonKey = imageBackendCapability.state !== 'full'
    ? imageBackendCapability.reasonKey
    : imageProfile?.reasonKey
  const imageUnsupportedReason = imageUnsupportedReasonKey
    ? t(imageUnsupportedReasonKey)
    : t('imageInput.errors.model_unsupported')
  const imageBusy = imageBusyKeys.has(imageDraftKey)

  useEffect(() => {
    if (backends.length === 0) void fetchBackends()
  }, [backends.length, fetchBackends])

  useEffect(() => {
    if (providers.length === 0) void fetchProviders()
  }, [fetchProviders, providers.length])

  useEffect(() => {
    const el = inputCardRef.current
    if (!el) return

    const measure = () => {
      const nextWidth = el.offsetWidth
      setContentWidth((prev) => (prev === nextWidth ? prev : nextWidth))
    }

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    imageComposerDisposedRef.current = false
    const intakeKeys = imageIntakeKeysRef.current
    const intakeRevisions = imageIntakeRevisionsRef.current
    return () => {
      imageComposerDisposedRef.current = true
      for (const key of intakeKeys) {
        intakeRevisions.set(
          key,
          (intakeRevisions.get(key) ?? 0) + 1,
        )
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (undoGroupTimerRef.current) {
        clearTimeout(undoGroupTimerRef.current)
      }
    }
  }, [])

  const maxHeight = Math.max(Math.round(window.innerHeight * 0.4), 160)

  const setCommittedReferences = (
    references: CommittedPromptReference[],
  ): void => {
    if (sameCommittedReferences(committedReferencesRef.current, references)) {
      return
    }
    committedReferencesRef.current = references
    setCommittedReferencesState(references)
  }

  const pushUndoState = (
    value: string,
    caret: number,
    references = committedReferencesRef.current,
  ): void => {
    const last = undoStackRef.current[undoStackRef.current.length - 1]
    if (
      last &&
      last.value === value &&
      last.caret === caret &&
      sameCommittedReferences(last.references, references)
    ) {
      return
    }
    undoStackRef.current.push({
      value,
      caret,
      references: cloneCommittedReferences(references),
    })
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
  const editableEnabled = !disabled && !isComposerLocked && !isRestarting
  const placeholder = t('placeholder')
  const placeholderVisible = !input && !isFocused

  useEffect(() => {
    // Presets can update the draft store without passing through the editor.
    // Rebase existing chips and validate new references just like restoration.
    const externalDraftChange = prevInputRef.current !== input
    const references = externalDraftChange
      ? rebaseCommittedReferences(prevInputRef.current, input, committedReferencesRef.current)
      : committedReferencesRef.current
    if (externalDraftChange) pendingReferenceCommitRef.current = { source: 'restore' }
    let next = reconcileCommittedReferenceStatuses(references, candidates)
    const pendingCommit = pendingReferenceCommitRef.current
    if (pendingCommit) {
      next = commitValidatedReferences(input, next, candidates, pendingCommit)
      if (!candidates.some((candidate) => candidate.status === 'pending')) {
        pendingReferenceCommitRef.current = null
      }
    }
    setCommittedReferences(next)
  }, [candidates, input])

  // File chips render a shortened basename; hovering one reveals the full
  // reference (or its resolution failure) in an instant tooltip. Chips are
  // imperative DOM, so this is hover delegation rather than a Radix tooltip.
  useEffect(() => {
    const editor = editableRef.current
    const host = editor?.parentElement
    if (!editor || !host) return

    const hide = () => setReferenceTooltip(null)

    const show = (target: HTMLElement) => {
      const label =
        target.getAttribute('aria-label') ?? target.dataset.referenceText
      const shortened = target.dataset.referenceText !== target.textContent
      const invalid = target.dataset.referenceStatus === 'invalid'
      if (!label || (!shortened && !invalid)) return
      const chipRect = target.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      // Viewport coordinates: the tooltip is portaled to <body> with
      // position: fixed, so it escapes every clipping ancestor (the
      // collapsing editor wrapper clips anything outside its box).
      const above = chipRect.top > 30
      const halfWidth = Math.min(Math.max(hostRect.width / 2, 80), 140)
      const minLeft = hostRect.left + halfWidth
      setReferenceTooltip({
        text: label,
        above,
        left: Math.min(
          Math.max(chipRect.left + chipRect.width / 2, minLeft),
          Math.max(hostRect.right - halfWidth, minLeft),
        ),
        top: above ? chipRect.top : chipRect.bottom,
      })
    }

    const chipUnder = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element
        ? node.closest<HTMLElement>('[data-prompt-reference-chip]')
        : null

    const onMouseOver = (e: MouseEvent) => {
      const chip = chipUnder(e.target)
      if (chip) show(chip)
      else hide()
    }
    const onMouseOut = (e: MouseEvent) => {
      if (!chipUnder(e.target)) return
      if (!chipUnder(e.relatedTarget)) hide()
    }

    editor.addEventListener('mouseover', onMouseOver)
    editor.addEventListener('mouseout', onMouseOut)
    editor.addEventListener('mouseleave', hide)
    editor.addEventListener('input', hide)
    // Fixed-position tooltips go stale whenever any scrollable ancestor
    // (editor, chat panel, window) scrolls the chip out from under them.
    window.addEventListener('scroll', hide, { capture: true, passive: true })
    return () => {
      editor.removeEventListener('mouseover', onMouseOver)
      editor.removeEventListener('mouseout', onMouseOut)
      editor.removeEventListener('mouseleave', hide)
      editor.removeEventListener('input', hide)
      window.removeEventListener('scroll', hide, { capture: true })
    }
  }, [])

  // Reconcile only structural/status changes or external draft replacement.
  // Ordinary native input already owns the current DOM and is not rebuilt.
  useEffect(() => {
    const el = editableRef.current
    if (!el || isComposingRef.current) return
    if (chipProjectionMatches(el, input, committedReferences)) return

    const active = document.activeElement === el
    const [anchor, focus] = active
      ? getSelectionAnchorFocusOffsets(el)
      : [input.length, input.length]
    projectPromptReferenceChips(el, input, committedReferences, {
      invalidLabel: (reference) =>
        t(
          reference.kind === 'skill'
            ? 'promptReference.invalidSkill'
            : 'promptReference.invalidFile',
          { reference: reference.text },
        ),
    })
    if (active) setSelectionOffsets(el, anchor, focus)
  }, [committedReferences, input, t])

  useEffect(() => {
    const normalizeSelection = () => {
      const el = editableRef.current
      const selection = window.getSelection()
      if (!el || !selection?.anchorNode || !selection.focusNode) return
      const insideChip = (node: Node) => {
        const element =
          node.nodeType === Node.ELEMENT_NODE
            ? (node as Element)
            : node.parentElement
        return Boolean(
          element?.closest('[data-prompt-reference-chip]') &&
            el.contains(element),
        )
      }
      if (!insideChip(selection.anchorNode) && !insideChip(selection.focusNode)) {
        return
      }
      const [anchor, focus] = getSelectionAnchorFocusOffsets(el)
      setSelectionOffsets(el, anchor, focus)
    }
    document.addEventListener('selectionchange', normalizeSelection)
    return () =>
      document.removeEventListener('selectionchange', normalizeSelection)
  }, [])

  useEffect(() => {
    prevInputRef.current = input
  }, [input])

  useEffect(() => {
    const draftSource = `${workspaceId}\0${sessionId}`
    if (referenceDraftSourceRef.current === draftSource) return
    referenceDraftSourceRef.current = draftSource
    setPickerOpen(false)
    setFilePickerOpen(false)
    setHistoryPickerOpen(false)
    setFileTriggerStart(null)
    setSlashTriggerStart(null)
    setArgumentHint(null)
    setLastInsertedCommand(null)
    const restoredReferences = restoreCommittedReferences(input, candidates)
    committedReferencesRef.current = restoredReferences
    setCommittedReferencesState(restoredReferences)
    pendingReferenceCommitRef.current = { source: 'restore' }
    undoStackRef.current = []
    redoStackRef.current = []
    undoGroupOpenRef.current = false
    if (undoGroupTimerRef.current) {
      clearTimeout(undoGroupTimerRef.current)
      undoGroupTimerRef.current = null
    }
  }, [candidates, input, sessionId, workspaceId])

  // Clear stuck IME composition state when the surface becomes non-editable.
  useEffect(() => {
    if (!editableEnabled) {
      isComposingRef.current = false
    }
  }, [editableEnabled])

  const handleInputChange = (
    value: string,
    cursorPos: number,
    options?: {
      skipInputSideEffects?: boolean
      commitSource?: PromptReferenceCommitSource
      immediateCandidates?: ValidatedPromptReference[]
    },
  ) => {
    const prev = prevInputRef.current
    let nextReferences = rebaseCommittedReferences(
      prev,
      value,
      committedReferencesRef.current,
    )
    if (options?.immediateCandidates) {
      nextReferences = commitValidatedReferences(
        value,
        nextReferences,
        options.immediateCandidates,
        { source: options.commitSource ?? 'picker' },
      )
      pendingReferenceCommitRef.current = null
    } else if (!options?.skipInputSideEffects) {
      pendingReferenceCommitRef.current = {
        source: options?.commitSource ?? 'manual',
      }
    }
    setCommittedReferences(nextReferences)
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

    // Detect @ trigger only while the composer is available.
    if (
      !isComposerLocked &&
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

    // Detect / trigger only while the composer is available.
    if (
      !isComposerLocked &&
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
    setCommittedReferences([])
    pendingReferenceCommitRef.current = null
    setDraft(sessionId, '')
    prevInputRef.current = ''
    setArgumentHint(null)
    setLastInsertedCommand(null)
    setSlashTriggerStart(null)
  }

  const handleSend = async () => {
    const sendInput = input
    const trimmed = sendInput.trim()
    if (
      (!trimmed && images.length === 0) ||
      disabled ||
      isComposerLocked ||
      isRestarting ||
      (images.length > 0 && !imageInputAvailable) ||
      (!hasSession && !isNewChat) ||
      sendInFlightRef.current
    ) {
      return
    }

    sendInFlightRef.current = true
    const invalidReferenceIdsBeforeRefresh = new Set(
      committedReferencesRef.current
        .filter((reference) => reference.status === 'invalid')
        .map((reference) => reference.id),
    )
    try {
      const commandsResult = await refreshCommands()
      const validationResult = await refreshReferences(
        commandsResult.succeeded ? commandsResult.commands : undefined,
      )
      if (prevInputRef.current !== sendInput) return

      let nextReferences = reconcileCommittedReferenceStatuses(
        committedReferencesRef.current,
        validationResult.candidates,
      )
      nextReferences = commitValidatedReferences(
        sendInput,
        nextReferences,
        validationResult.candidates,
        { source: 'manual', commitAtEnd: true },
      )
      pendingReferenceCommitRef.current = null
      setCommittedReferences(nextReferences)

      // A newly stale reference must be visible before the user chooses to
      // send it. A second explicit send is allowed without removing the chip.
      if (
        nextReferences.some(
          (reference) =>
            reference.status === 'invalid' &&
            !invalidReferenceIdsBeforeRefresh.has(reference.id),
        )
      ) {
        editableRef.current?.focus()
        return
      }

      onSend({ text: sendInput, images })
      // New Chat owns the draft until session creation succeeds, so recoverable
      // creation failures can leave the user's prompt intact for retry.
      if (!isNewChat) resetInput()
      editableRef.current?.focus()
    } finally {
      sendInFlightRef.current = false
      submitLockRef.current = false
    }
  }

  const handleClear = () => {
    const el = editableRef.current
    if (el) {
      pushUndoState(input, getCaretOffset(el))
    }
    images.forEach(releasePromptImage)
    imageIntakeRevisionsRef.current.set(
      imageDraftKey,
      (imageIntakeRevisionsRef.current.get(imageDraftKey) ?? 0) + 1,
    )
    setImageDrafts(workspaceId, sessionId, [])
    setImageErrors((current) => {
      const next = { ...current }
      delete next[imageDraftKey]
      return next
    })
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

  const handleRemoveImage = (imageId: string) => {
    const removed = images.find((image) => image.id === imageId)
    if (removed) releasePromptImage(removed)
    setImageDrafts(
      workspaceId,
      sessionId,
      images.filter((image) => image.id !== imageId),
    )
  }

  const handleMoveImage = (fromIndex: number, toIndex: number) => {
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= images.length ||
      toIndex >= images.length ||
      fromIndex === toIndex
    ) return
    const reordered = [...images]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    setImageDrafts(workspaceId, sessionId, reordered)
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
    void refreshCommands().then((result) =>
      refreshReferences(result.succeeded ? result.commands : undefined),
    )
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

  const insertTransferredText = (text: string) => {
    if (!text) return
    const el = editableRef.current
    if (!el) return
    const [start, end] = getSelectionOffsets(el)
    pushUndoState(input, start)
    replaceText(el, text, start, end)
    handleInputChange(extractPlainText(el), getCaretOffset(el), {
      commitSource: 'paste',
    })
  }

  const handleImageFiles = async (candidateFiles: readonly File[]) => {
    if (candidateFiles.length === 0) return
    const operationWorkspaceId = workspaceId
    const operationSessionId = sessionId
    const operationKey = promptImageDraftKey(operationWorkspaceId, operationSessionId)
    if (!imageInputAvailable || !imageProfile) {
      setImageErrors((current) => ({
        ...current,
        [operationKey]: imageUnsupportedReason,
      }))
      return
    }
    if (imageIntakeKeysRef.current.has(operationKey)) return
    imageIntakeKeysRef.current.add(operationKey)
    const operationRevision = imageIntakeRevisionsRef.current.get(operationKey) ?? 0

    const existingImages = useChatStore.getState().imageDrafts[operationKey] ?? []
    setImageErrors((current) => {
      const next = { ...current }
      delete next[operationKey]
      return next
    })
    setImageBusyKeys((current) => new Set(current).add(operationKey))
    try {
      const added = await normalizeImageBatch(candidateFiles, {
        existingImages,
        limits: imageProfile.limits,
      })
      if (
        imageComposerDisposedRef.current ||
        (imageIntakeRevisionsRef.current.get(operationKey) ?? 0) !== operationRevision
      ) {
        added.forEach((image) => releasePromptImage(image))
        return
      }
      const latest = useChatStore.getState().imageDrafts[operationKey] ?? []
      const totalBase64Bytes = [...latest, ...added]
        .reduce((total, image) => total + image.data.length, 0)
      if (
        latest.length + added.length > imageProfile.limits.maxImages ||
        totalBase64Bytes > imageProfile.limits.maxBase64BytesPerBatch
      ) {
        added.forEach((image) => releasePromptImage(image))
        throw new ImageInputError('batch_too_large', 'The image batch is too large')
      }
      setImageDrafts(operationWorkspaceId, operationSessionId, [...latest, ...added])
    } catch (error) {
      if (
        imageComposerDisposedRef.current ||
        (imageIntakeRevisionsRef.current.get(operationKey) ?? 0) !== operationRevision
      ) return
      const code = error instanceof ImageInputError ? error.code : 'invalid_dimensions'
      setImageErrors((current) => ({
        ...current,
        [operationKey]: t(`imageInput.errors.${code}`),
      }))
    } finally {
      imageIntakeKeysRef.current.delete(operationKey)
      if (!imageComposerDisposedRef.current) {
        setImageBusyKeys((current) => {
          const next = new Set(current)
          next.delete(operationKey)
          return next
        })
      }
    }
  }

  const imageFilesFromTransfer = (transfer: DataTransfer): File[] =>
    Array.from(transfer.files).filter((file) => file.type.startsWith('image/'))

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    insertTransferredText(text)
    void handleImageFiles(imageFilesFromTransfer(e.clipboardData))
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.dataTransfer.getData('text/plain')
    insertTransferredText(text)
    void handleImageFiles(imageFilesFromTransfer(e.dataTransfer))
  }

  const deleteModelRange = (start: number, end: number): void => {
    flushUndoGroup()
    pushUndoState(input, start)
    const value = `${input.slice(0, start)}${input.slice(end)}`
    handleInputChange(value, start, {
      skipInputSideEffects: true,
    })
    requestAnimationFrame(() => {
      const current = editableRef.current
      if (current) setCaretOffset(current, start)
    })
  }

  const deletePromptReferenceAtSelection = (
    direction: 'backward' | 'forward',
  ): boolean => {
    const el = editableRef.current
    if (!el) return false
    const [start, end] = getSelectionOffsets(el)
    const deletion = getPromptReferenceDeletionRange(
      el,
      start,
      end,
      direction,
    )
    if (!deletion) return false

    deleteModelRange(deletion.start, deletion.end)
    return true
  }

  // Chips render a shortened basename label while the plain-text model keeps
  // the full path, so clipboard writes must come from the model, not the
  // rendered selection string.
  const handleCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = editableRef.current
      ? getSelectionPlainText(editableRef.current)
      : null
    if (text === null) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', text)
  }

  const handleCut = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = editableRef.current
    const text = el === null ? null : getSelectionPlainText(el)
    if (el === null || text === null) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', text)
    const [rawStart, rawEnd] = getSelectionOffsets(el)
    const start = Math.min(rawStart, rawEnd)
    const end = Math.max(rawStart, rawEnd)
    const deletion =
      getPromptReferenceDeletionRange(el, start, end, 'backward') ??
      { start, end }
    deleteModelRange(deletion.start, deletion.end)
  }

  const handleBeforeInput = (e: React.FormEvent<HTMLDivElement>) => {
    const inputType = (e.nativeEvent as InputEvent).inputType ?? ''
    if (
      inputType === 'insertFromPaste' ||
      inputType === 'historyUndo' ||
      inputType === 'historyRedo'
    ) {
      e.preventDefault()
      return
    }
    if (
      inputType.startsWith('format') ||
      inputType === 'insertOrderedList' ||
      inputType === 'insertUnorderedList' ||
      inputType === 'insertHorizontalRule'
    ) {
      e.preventDefault()
      return
    }
    if (
      inputType === 'deleteContentBackward' ||
      inputType === 'deleteContentForward'
    ) {
      if (
        deletePromptReferenceAtSelection(
          inputType === 'deleteContentBackward' ? 'backward' : 'forward',
        )
      ) {
        e.preventDefault()
        return
      }
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

    if (
      !isComposingRef.current &&
      editableEnabled &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (e.key === 'Backspace' || e.key === 'Delete') &&
      deletePromptReferenceAtSelection(
        e.key === 'Backspace' ? 'backward' : 'forward',
      )
    ) {
      e.preventDefault()
      return
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
        const current: PromptUndoSnapshot = {
          value: input,
          caret: getCaretOffset(el),
          references: cloneCommittedReferences(committedReferencesRef.current),
        }
        const previous = undoStackRef.current.pop()!
        redoStackRef.current.push(current)
        undoGroupOpenRef.current = false
        pendingReferenceCommitRef.current = null
        setCommittedReferences(cloneCommittedReferences(previous.references))
        setDraft(sessionId, previous.value)
        prevInputRef.current = previous.value
        requestAnimationFrame(() => setCaretOffset(el, previous.caret))
      } else {
        flushUndoGroup()
        if (redoStackRef.current.length === 0) return
        const current: PromptUndoSnapshot = {
          value: input,
          caret: getCaretOffset(el),
          references: cloneCommittedReferences(committedReferencesRef.current),
        }
        const next = redoStackRef.current.pop()!
        undoStackRef.current.push(current)
        undoGroupOpenRef.current = false
        pendingReferenceCommitRef.current = null
        setCommittedReferences(cloneCommittedReferences(next.references))
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
      !isComposerLocked &&
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

    if (
      !isComposingRef.current &&
      shouldSubmitOnEnter(e, useModifierToSubmit)
    ) {
      e.preventDefault()
      if (submitLockRef.current) return
      submitLockRef.current = true
      void handleSend()
    }
  }

  const handleKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // macOS does not dispatch an Enter keyup for Cmd+Enter, so release the
    // submit lock when either half of the shortcut is released.
    if (e.key === 'Enter' || e.key === 'Meta' || e.key === 'Control') {
      submitLockRef.current = false
    }
  }

  useEffect(() => {
    const focus = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) editableRef.current?.focus()
    }
    window.addEventListener('comate:focus-prompt', focus)
    return () => window.removeEventListener('comate:focus-prompt', focus)
  }, [sessionId])

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
    handleInputChange(value, pos, {
      commitSource: 'picker',
      immediateCandidates: [
        {
          kind: 'skill',
          value: command.name,
          start,
          end: start + inserted.trimEnd().length,
          status: 'valid',
        },
      ],
    })
    setLastInsertedCommand(inserted)
    setArgumentHint(command.argumentHint ?? null)
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
    handleInputChange(value, pos, {
      commitSource: 'picker',
      immediateCandidates: [
        {
          kind: 'file',
          value: selectedPath,
          start,
          end: start + inserted.trimEnd().length,
          status: 'valid',
        },
      ],
    })
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
    setCommittedReferences(
      selectedPrompt === input
        ? restoreCommittedReferences(selectedPrompt, candidates)
        : [],
    )
    pendingReferenceCommitRef.current = { source: 'restore' }
    setDraft(sessionId, selectedPrompt)
    prevInputRef.current = selectedPrompt
    setHistoryPickerOpen(false)
    requestAnimationFrame(() => {
      const el = editableRef.current
      if (!el) return
      el.focus()
      setCaretOffset(el, selectedPrompt.length)
    })
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

  const lockedBackendUnavailable =
    !isNewChat && !!sessionBackend && backendAvailability(backends, sessionBackend)?.status === 'unavailable'

  const hasDraftContent = input.trim().length > 0 || images.length > 0
  const canSend = hasDraftContent && (hasSession || isNewChat) && !hasPendingTurn && !isComposerLocked && !isRestarting && !disabled && !lockedBackendUnavailable && !imageBusy && (images.length === 0 || imageInputAvailable)
  const canClear = input.length > 0 || images.length > 0
  const toolbarVisibility = getToolbarVisibility(contentWidth)
  const showSubmitHint = contentWidth !== undefined && contentWidth >= 720
  const {
    showHistory,
    showProvider,
    showFast,
    showApproval,
    showClear,
  } = toolbarVisibility

  const imageIntakeDisabled = disabled || isComposerLocked || isRestarting || imageBusy || !imageInputAvailable
  const historyDisabled = disabled || isComposerLocked || isRestarting || !hasSession || isNewChat
  const imageRailError = imageErrors[imageDraftKey]
    ?? (normalizedActiveBackend && !imageInputAvailable ? imageUnsupportedReason : null)

  const handleStopBackgroundTask = async (taskId: string) => {
    const stopKey = getBackgroundTaskStopKey(sessionId, taskId)
    setStoppingBackgroundTaskIds((current) => new Set(current).add(stopKey))
    try {
      await stopBackgroundTask(workspaceId, sessionId, taskId)
    } finally {
      setStoppingBackgroundTaskIds((current) => {
        const next = new Set(current)
        next.delete(stopKey)
        return next
      })
    }
  }

  const stopControl = (isComposerLocked || isStreaming) ? (
    <Popover open={stopPopoverOpen} onOpenChange={setStopPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          disabled={isInterrupting}
          aria-label={isInterrupting ? t('stopPopover.stopping') : t('stop')}
          title={isInterrupting ? t('stopPopover.stopping') : t('stop')}
          className="p-1.5 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive/80 transition-colors flex items-center gap-1.5 border border-destructive/20"
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
        <p className="text-text-primary mb-3">
          {backgroundTaskCount > 0
            ? t('stopPopover.titleWithTasks', { count: backgroundTaskCount })
            : t('stopPopover.title')}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setStopPopoverOpen(false)}
            disabled={isInterrupting}
            className="px-3 py-1.5 font-medium text-text-secondary hover:text-text-primary rounded-md hover:bg-chrome-hover transition-colors"
          >
            {t('stopPopover.cancel')}
          </button>
          <button
            onClick={() => {
              onStop?.()
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
  ) : null

  const historyButton = (
    <button
      type="button"
      onClick={handleHistoryClick}
      disabled={historyDisabled}
      className={showHistory ? 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-chrome-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed' : 'hidden'}
      title={`${t('history')} (${t('historyShortcutHint')})`}
    >
      <History className="w-3 h-3" />
      <span className="hidden sm:inline">{t('history')}</span>
    </button>
  )

  return (
    <div
      className={`max-w-3xl mx-auto ${
        isBotSession ? 'px-4 py-2' : isNewChat ? 'py-0' : 'px-4 py-4'
      }`}
    >
      {lockedBackendUnavailable && (
        <div className="mb-2 px-3 py-1.5 text-[11px] rounded-md text-destructive bg-destructive/10 border border-destructive/20">
          {t('backend.unavailableReadOnly', { backend: sessionBackend })}
        </div>
      )}
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
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-chrome-hover active:bg-chrome-active active:scale-[0.98] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
              disabled={isComposerLocked || isRestarting}
              hideNameBelowSm
            />
          </div>
        </div>
      ) : (
        <>
          {(backgroundTasks.length > 0 || activity?.phase === 'stopping') && (
            <div
              className="relative z-10 mx-auto mb-2 w-fit max-w-full max-h-28 overflow-y-auto rounded-lg border border-border/80 bg-surface/95 px-2.5 py-2 text-[11px] text-text-secondary shadow-[0_8px_24px_-14px_rgba(0,0,0,0.45)] backdrop-blur-sm"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="session-activity-details"
            >
              <div className="flex min-w-0 items-start gap-2">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-agent/10 text-agent">
                  {activity?.phase === 'stopping' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="font-medium leading-6 text-text-primary">
                    {activity?.phase === 'stopping'
                      ? t('activity.stopping')
                      : t('activity.backgroundRunning', { count: backgroundTasks.length })}
                  </div>
                  {backgroundTasks.length > 0 && (
                    <div className="mt-0.5 space-y-1">
                      {backgroundTasks.map((task) => {
                        const isStopping = stoppingBackgroundTaskIds.has(
                          getBackgroundTaskStopKey(sessionId, task.id),
                        )
                        const stopTaskLabel = t(
                          isStopping ? 'activity.stoppingTask' : 'activity.stopTask',
                          { description: task.description },
                        )

                        return <div key={task.id} className="flex min-w-0 items-start gap-1.5 leading-4">
                          <span className="flex-shrink-0 text-text-tertiary">
                            {getBackgroundTaskTypeLabel(task.type, t)}
                          </span>
                          <span className="min-w-0 flex-1 break-words">{task.description}</span>
                          {sessionBackend === 'claude' && activity?.phase !== 'stopping' && (
                            <button
                              type="button"
                              onClick={() => void handleStopBackgroundTask(task.id)}
                              disabled={isStopping}
                              aria-label={stopTaskLabel}
                              title={stopTaskLabel}
                              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isStopping ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Square className="h-2.5 w-2.5 fill-current" />
                              )}
                            </button>
                          )}
                        </div>
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        <div
          ref={inputCardRef}
          data-testid="input-card"
          className={isNewChat
            ? 'relative bg-work'
            : 'relative rounded-xl border border-border bg-work shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.12)] transition-colors focus-within:border-border-hover'}
        >
          <>
            <input
              ref={imageFileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={imageIntakeDisabled}
              onChange={(event) => {
                const selected = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
                void handleImageFiles(selected)
              }}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
            />
            <PromptImageRail
              images={images}
              busy={imageBusy}
              error={imageRailError}
              disabled={disabled || isComposerLocked || isRestarting}
              onRemove={handleRemoveImage}
              onMove={handleMoveImage}
            />
            <div
              className={`grid transition-[grid-template-rows] duration-300 ease-out ${isComposerLocked ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}
            >
              <div className="overflow-hidden min-h-0">
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
                    contentEditable={editableEnabled ? 'true' : 'false'}
                    tabIndex={editableEnabled ? 0 : -1}
                    onInput={handleInput}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onKeyDown={handleKeyDown}
                    onKeyUp={handleKeyUp}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                    onPaste={handlePaste}
                    onCopy={handleCopy}
                    onCut={handleCut}
                    onDrop={handleDrop}
                    onBeforeInput={handleBeforeInput}
                    className={`prompt-input-editor relative z-10 w-full bg-transparent border-0 px-4 py-3 text-text-primary focus:outline-none focus:ring-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words ${!editableEnabled ? 'opacity-50' : ''}`}
                    style={{ minHeight: '44px', maxHeight: `${maxHeight}px` }}
                  />
                  <PromptGhostText
                    input={input}
                    argumentHint={argumentHint}
                    lastInsertedCommand={lastInsertedCommand}
                  />
                  {referenceTooltip &&
                    createPortal(
                      <div
                        role="tooltip"
                        className="pointer-events-none fixed z-50 w-fit max-w-[min(28rem,90vw)] select-none rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary shadow-md"
                        style={{
                          left: referenceTooltip.left,
                          top: referenceTooltip.top,
                          overflowWrap: 'anywhere',
                          transform: referenceTooltip.above
                            ? 'translate(-50%, calc(-100% - 4px))'
                            : 'translate(-50%, 4px)',
                        }}
                      >
                        {referenceTooltip.text}
                      </div>,
                      document.body,
                    )}
                </div>
              </div>
            </div>
            <div data-testid="prompt-input-toolbar" className="flex items-center px-2 pb-2 pt-1 gap-1">
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                <button
                  type="button"
                  onClick={() => imageFileInputRef.current?.click()}
                  disabled={imageIntakeDisabled}
                  aria-label={t('imageInput.attach')}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-text-tertiary transition-colors hover:bg-chrome-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  title={imageInputAvailable ? t('imageInput.attach') : imageUnsupportedReason}
                >
                  <ImagePlus className="h-3 w-3" />
                  <span className="hidden sm:inline">{t('imageInput.attach')}</span>
                </button>
                <CommandPicker
                  ref={pickerHandleRef}
                  workspaceId={workspaceId}
                  sessionId={commandSessionId}
                  backendId={activeBackend}
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
                  contentWidth={contentWidth}
                  anchor={<span className="hidden" />}
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
                  contentWidth={contentWidth}
                  anchor={<span className="hidden" />}
                />
                {isNewChat ? historyButton : (
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
                    contentWidth={contentWidth}
                    anchor={historyButton}
                  />
                )}
              </div>
              <div className="ml-auto flex min-w-0 items-center justify-end gap-1 overflow-hidden">
                {isNewChat ? (
                  <>
                    <BackendSelector
                      mode="new-chat"
                      workspaceId={workspaceId}
                      backendId={props.backendId}
                      onBackendChange={props.onBackendChange}
                      disabled={disabled}
                      hideNameBelowSm
                    />
                    {showProvider && (
                      <ProviderSelector
                        mode="new-chat"
                        workspaceId={workspaceId}
                        backendId={props.backendId}
                        providerId={props.providerId}
                        onProviderChange={props.onProviderChange}
                        codexModel={props.codexModel ?? null}
                        codexEffort={props.codexEffort ?? null}
                        codexSpeed={props.codexSpeed ?? null}
                        onCodexSettingsChange={props.onCodexSettingsChange ?? (() => undefined)}
                        disabled={disabled}
                        hideNameBelowSm
                      />
                    )}
                    {showFast && (
                      <FastModeToggle
                        mode="new-chat"
                        workspaceId={workspaceId}
                        providerId={props.providerId}
                        fastMode={props.fastMode}
                        onFastModeChange={props.onFastModeChange}
                        disabled={disabled}
                      />
                    )}
                    {showApproval && (
                      <ApprovalModeToggle
                        mode="new-chat"
                        workspaceId={workspaceId}
                        approvalMode={props.approvalMode}
                        onApprovalModeChange={props.onApprovalModeChange}
                        disabled={disabled}
                        hideNameBelowSm
                      />
                    )}
                  </>
                ) : sessionId && !isBotSession ? (
                  <>
                    <BackendSelector workspaceId={workspaceId} sessionId={sessionId} disabled={isComposerLocked || isRestarting} hideNameBelowSm />
                    {showProvider && <ProviderSelector workspaceId={workspaceId} sessionId={sessionId} disabled={isComposerLocked || isRestarting} hideNameBelowSm />}
                    {showFast && <FastModeToggle workspaceId={workspaceId} sessionId={sessionId} disabled={isComposerLocked || isRestarting} />}
                    {showApproval && <ApprovalModeToggle workspaceId={workspaceId} sessionId={sessionId} disabled={isComposerLocked || isRestarting} hideNameBelowSm />}
                  </>
                ) : null}
                {canClear && showClear && (
                  <button
                    onClick={handleClear}
                    disabled={isInterrupting}
                    className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary transition-colors"
                    title={t('clear')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                {!isComposerLocked && useModifierToSubmit && showSubmitHint && (
                  <span className="text-[10px] text-text-tertiary select-none">
                    {/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? 'Cmd+Enter' : 'Ctrl+Enter'}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {isComposerLocked ? (
                  stopControl
                ) : (
                  <>
                    {isStreaming && stopControl}
                    <button
                      onClick={() => void handleSend()}
                      disabled={!canSend}
                      className="p-1.5 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 hover:text-accent/80 transition-colors flex items-center gap-1.5 border border-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={t('send')}
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        </div>
        </>
      )}
    </div>
  )
}
