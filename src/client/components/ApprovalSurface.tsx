import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useId,
} from 'react'
import { Loader2, Square, SlashSquare, Paperclip } from 'lucide-react'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

import type { QuestionPayload } from '../types/message'
import type { SlashCommandDto } from '../stores/commands-store'
import { Button } from './ui/button'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from './ui/popover'
import CommandPicker, { type CommandPickerHandle } from './CommandPicker'
import FilePicker, { type FilePickerHandle } from './FilePicker'
import PreviewPane from './PreviewPane'

export const CHAT_ABOUT_THIS_MESSAGE =
  'I have questions before answering — can we discuss the options before I pick?'

const OTHER_LABEL = 'Other'

interface PendingApproval {
  requestId: string
  toolName: string
  toolUseId: string
  input: unknown
  inputSummary: string
  title?: string
  description?: string
  suggestions?: PermissionUpdate[]
}

interface PendingQuestion {
  requestId: string
  questions: QuestionPayload[]
}

type PendingItem = PendingApproval | PendingQuestion

interface ApprovalSurfaceProps {
  workspaceId: string
  pendingItem: PendingItem
  queueDepth: number
  isResolving?: boolean
  onAllow: () => void
  onAllowAlways: () => void
  onDeny: (message: string) => void
  onAnswerQuestion: (answers: Record<string, string>) => void
  onChatAbout: () => void
  onStop: () => void
}

export default function ApprovalSurface({
  workspaceId,
  pendingItem,
  queueDepth,
  isResolving = false,
  onAllow,
  onAllowAlways,
  onDeny,
  onAnswerQuestion,
  onChatAbout,
  onStop,
}: ApprovalSurfaceProps) {
  const titleId = useId()
  const isQuestion = 'questions' in pendingItem
  const headerTitle = isQuestion
    ? 'Clarifying question'
    : pendingItem.title || pendingItem.toolName
  const headerDescription = isQuestion
    ? undefined
    : pendingItem.description
  const queueLabel = queueDepth > 0 ? `1 of ${queueDepth + 1}` : null

  const [stepIndex, setStepIndex] = useState(0)
  const questions = isQuestion
    ? (pendingItem as PendingQuestion).questions
    : []
  const isStepper = questions.length >= 2

  // Reset step on new pending item
  useEffect(() => {
    setStepIndex(0)
  }, [pendingItem.requestId])

  const stepLabel =
    isStepper ? `${stepIndex + 1} of ${questions.length}` : null
  const positionLabel = isStepper ? stepLabel : queueLabel

  return (
    <div className="max-w-3xl mx-auto px-4 py-3">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-live="polite"
        className="bg-surface border border-border/50 rounded-lg px-4 py-3"
      >
        <header className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <h2
              id={titleId}
              className="text-sm font-semibold text-text-primary truncate"
            >
              {headerTitle}
            </h2>
            {headerDescription && (
              <span className="text-xs text-text-secondary truncate">
                {headerDescription}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {positionLabel && (
              <span className="text-xs text-text-tertiary">
                {positionLabel}
              </span>
            )}
            <StopButton onStop={onStop} isResolving={isResolving} />
          </div>
        </header>

        {isQuestion ? (
          <QuestionView
            workspaceId={workspaceId}
            item={pendingItem as PendingQuestion}
            isResolving={isResolving}
            stepIndex={stepIndex}
            onStepChange={setStepIndex}
            onAnswerQuestion={onAnswerQuestion}
            onChatAbout={onChatAbout}
          />
        ) : (
          <ApprovalView
            item={pendingItem as PendingApproval}
            isResolving={isResolving}
            onAllow={onAllow}
            onAllowAlways={onAllowAlways}
            onDeny={onDeny}
          />
        )}
      </div>
    </div>
  )
}

function StopButton({
  onStop,
  isResolving,
}: {
  onStop: () => void
  isResolving: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Stop"
          title="Stop"
          disabled={isResolving}
          className="p-1.5 rounded-md text-text-tertiary hover:text-accent hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="relative w-4 h-4 flex items-center justify-center">
            <Loader2 className="absolute inset-0 w-4 h-4 animate-spin opacity-60" />
            <Square className="w-2 h-2 fill-current" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="bg-surface border border-border rounded-lg shadow-lg p-3 z-50"
      >
        <p className="text-sm text-text-primary mb-3">Cancel current turn?</p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            disabled={isResolving}
            className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onStop()
              setOpen(false)
            }}
            disabled={isResolving}
            className="px-3 py-1.5 text-xs font-medium text-accent-foreground bg-accent hover:bg-accent/90 rounded-md transition-colors"
          >
            {isResolving ? (
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
  )
}

function ApprovalView({
  item,
  isResolving,
  onAllow,
  onAllowAlways,
  onDeny,
}: {
  item: PendingApproval
  isResolving: boolean
  onAllow: () => void
  onAllowAlways: () => void
  onDeny: (message: string) => void
}) {
  const [showMore, setShowMore] = useState(false)
  const hasSuggestions = item.suggestions && item.suggestions.length > 0

  const inputStr =
    typeof item.input === 'string'
      ? item.input
      : JSON.stringify(item.input, null, 2)
  const isTruncated = inputStr.length > 200

  // Reset Show more across pendingItem swaps
  useEffect(() => {
    setShowMore(false)
  }, [item.requestId])

  return (
    <div>
      <div className="mb-3">
        <p className="text-xs text-text-secondary font-mono bg-bg rounded px-2 py-1.5 whitespace-pre-wrap break-words">
          {showMore ? inputStr : item.inputSummary}
        </p>
        {isTruncated && (
          <button
            onClick={() => setShowMore(!showMore)}
            className="text-xs text-accent hover:underline mt-1"
          >
            {showMore ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={onAllow} disabled={isResolving} size="sm" autoFocus>
          {isResolving ? (
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              …
            </span>
          ) : (
            'Allow'
          )}
        </Button>
        {hasSuggestions && (
          <Button
            onClick={onAllowAlways}
            disabled={isResolving}
            variant="secondary"
            size="sm"
          >
            Allow always
          </Button>
        )}
        <Button
          onClick={() => onDeny('User denied this tool call.')}
          disabled={isResolving}
          variant="destructive"
          size="sm"
        >
          Deny
        </Button>
      </div>
    </div>
  )
}

type FocusedOption = { qIdx: number; oIdx: number } | null

function QuestionView({
  workspaceId,
  item,
  isResolving,
  stepIndex,
  onStepChange,
  onAnswerQuestion,
  onChatAbout,
}: {
  workspaceId: string
  item: PendingQuestion
  isResolving: boolean
  stepIndex: number
  onStepChange: (index: number) => void
  onAnswerQuestion: (answers: Record<string, string>) => void
  onChatAbout: () => void
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>(
    {},
  )
  const [otherText, setOtherText] = useState<Record<string, string>>({})

  const isStepper = item.questions.length >= 2
  const currentQuestion = isStepper
    ? item.questions[stepIndex]
    : item.questions[0]

  const hasPreviews = useMemo(
    () => item.questions.some((q) => q.options.some((o) => !!o.preview)),
    [item.questions],
  )

  const currentHasPreviews = useMemo(
    () => currentQuestion?.options.some((o) => !!o.preview) ?? false,
    [currentQuestion],
  )

  const findInitialFocus = useCallback((): FocusedOption => {
    if (isStepper) {
      const q = item.questions[stepIndex]
      if (!q) return null
      for (let oi = 0; oi < q.options.length; oi++) {
        if (q.options[oi].preview) return { qIdx: stepIndex, oIdx: oi }
      }
      return q.options[0] ? { qIdx: stepIndex, oIdx: 0 } : null
    }
    for (let qi = 0; qi < item.questions.length; qi++) {
      const opts = item.questions[qi].options
      for (let oi = 0; oi < opts.length; oi++) {
        if (opts[oi].preview) return { qIdx: qi, oIdx: oi }
      }
    }
    return item.questions[0]?.options[0]
      ? { qIdx: 0, oIdx: 0 }
      : null
  }, [item.questions, isStepper, stepIndex])

  const [focused, setFocused] = useState<FocusedOption>(findInitialFocus)
  const [lastInteractionMode, setLastInteractionMode] = useState<
    'mouse' | 'keyboard'
  >('keyboard')

  // Reset state on requestId change (DO NOT add stepIndex here)
  useEffect(() => {
    setSelections({})
    setOtherSelected({})
    setOtherText({})
    setFocused(findInitialFocus())
    setLastInteractionMode('keyboard')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- findInitialFocus excluded to avoid clearing answers on step navigation
  }, [item.requestId])

  // Re-scope focus on step change
  useEffect(() => {
    if (!isStepper) return
    const initial = findInitialFocus()
    setFocused(initial)
    setLastInteractionMode('keyboard')
    if (initial) {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-option-key="${initial.qIdx}:${initial.oIdx}"]`,
        )
        el?.focus()
      })
    }
  }, [stepIndex, isStepper, findInitialFocus])

  const toggleOption = useCallback(
    (questionText: string, optionLabel: string, multiSelect: boolean) => {
      setSelections((prev) => {
        const current = prev[questionText] || []
        if (multiSelect) {
          const next = current.includes(optionLabel)
            ? current.filter((l) => l !== optionLabel)
            : [...current, optionLabel]
          return { ...prev, [questionText]: next }
        }
        const next = current.includes(optionLabel) ? [] : [optionLabel]
        // Single-select: selecting an option clears Other
        if (next.length > 0) {
          setOtherSelected((p) => ({ ...p, [questionText]: false }))
        }
        return { ...prev, [questionText]: next }
      })
    },
    [],
  )

  const toggleOther = useCallback(
    (questionText: string, multiSelect: boolean) => {
      setOtherSelected((prev) => {
        const next = !prev[questionText]
        if (next && !multiSelect) {
          // Single-select: deselecting Other clears regular options
          setSelections((sp) => ({ ...sp, [questionText]: [] }))
        }
        return { ...prev, [questionText]: next }
      })
      // When deselecting Other, discard its typed value
      setOtherText((prev) => {
        if (prev[questionText] === undefined) return prev
        const next = { ...prev }
        delete next[questionText]
        return next
      })
    },
    [],
  )

  const setOtherTextFor = useCallback(
    (questionText: string, value: string) => {
      setOtherText((prev) => ({ ...prev, [questionText]: value }))
    },
    [],
  )

  const allAnswered = item.questions.every((q) => {
    const selected = selections[q.question] || []
    const hasOther = otherSelected[q.question]
    if (hasOther) {
      const text = (otherText[q.question] || '').trim()
      if (!text) return false
      return true
    }
    return selected.length > 0
  })

  const currentAnswered = (() => {
    if (!currentQuestion) return false
    const selected = selections[currentQuestion.question] || []
    const hasOther = otherSelected[currentQuestion.question]
    if (hasOther) {
      const text = (otherText[currentQuestion.question] || '').trim()
      return !!text
    }
    return selected.length > 0
  })()

  const canConfirm = allAnswered && !isResolving
  const canNext = currentAnswered

  const handleConfirm = () => {
    if (!canConfirm) return
    const answers: Record<string, string> = {}
    for (const q of item.questions) {
      const selected = selections[q.question] || []
      const hasOther = otherSelected[q.question]
      const otherValue = (otherText[q.question] || '').trim()
      const labels = [...selected]
      let answer = labels.join(', ')
      if (hasOther && otherValue) {
        answer = answer ? `${answer}, ${otherValue}` : otherValue
      }
      answers[q.question] = answer
    }
    onAnswerQuestion(answers)
  }

  const focusedPreview = useMemo(() => {
    if (!focused) return null
    const effectiveQIdx = isStepper ? stepIndex : focused.qIdx
    const q = item.questions[effectiveQIdx]
    if (!q) return null
    if (focused.oIdx >= q.options.length) return null
    return q.options[focused.oIdx]?.preview ?? null
  }, [focused, item.questions, isStepper, stepIndex])

  const handleOptionFocus = (qIdx: number, oIdx: number) => {
    if (lastInteractionMode === 'mouse') return
    setFocused({ qIdx, oIdx })
  }

  const handleOptionMouseEnter = (qIdx: number, oIdx: number) => {
    setLastInteractionMode('mouse')
    setFocused({ qIdx, oIdx })
  }

  const handleOptionKey = (
    e: React.KeyboardEvent,
    qIdx: number,
    oIdx: number,
  ) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    setLastInteractionMode('keyboard')
    const q = item.questions[qIdx]
    const total = q.options.length + 1 // +1 for Other
    const nextOIdx =
      e.key === 'ArrowDown'
        ? (oIdx + 1) % total
        : (oIdx - 1 + total) % total
    setFocused({ qIdx, oIdx: nextOIdx })
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-option-key="${qIdx}:${nextOIdx}"]`,
      )
      el?.focus()
    })
  }

  const renderOption = (
    q: QuestionPayload,
    qIdx: number,
    oIdx: number,
    label: string,
    description: string | undefined,
    selected: boolean,
    onClick: () => void,
  ) => {
    const isFocused =
      focused && focused.qIdx === qIdx && focused.oIdx === oIdx
    return (
      <button
        key={`${qIdx}:${oIdx}:${label}`}
        type="button"
        role={q.multiSelect ? undefined : 'radio'}
        aria-checked={q.multiSelect ? undefined : selected}
        data-option-key={`${qIdx}:${oIdx}`}
        onClick={() => {
          setLastInteractionMode('keyboard')
          onClick()
        }}
        onFocus={() => handleOptionFocus(qIdx, oIdx)}
        onMouseEnter={() => handleOptionMouseEnter(qIdx, oIdx)}
        onKeyDown={(e) => handleOptionKey(e, qIdx, oIdx)}
        disabled={isResolving}
        className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
          selected
            ? 'bg-accent/10 text-accent border border-accent/30'
            : 'bg-bg text-text-secondary border border-border/50 hover:border-border'
        } ${isFocused ? 'ring-1 ring-accent/40' : ''} disabled:opacity-50`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`w-3.5 h-3.5 rounded-${q.multiSelect ? 'sm' : 'full'} border flex items-center justify-center flex-shrink-0 ${
              selected
                ? 'border-accent bg-accent'
                : 'border-text-tertiary'
            }`}
          >
            {selected && (
              <svg
                className="w-2.5 h-2.5 text-accent-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </span>
          <span className="font-medium">{label}</span>
        </div>
        {description && (
          <p className="mt-0.5 ml-5 text-text-tertiary">{description}</p>
        )}
      </button>
    )
  }

  const renderQuestion = (q: QuestionPayload, qIdx: number) => {
    const selectedSet = selections[q.question] || []
    const otherIsOn = !!otherSelected[q.question]
    return (
      <div
        key={`${qIdx}:${q.question}`}
        {...(isStepper
          ? {
              'aria-roledescription': 'step',
              'aria-label': `Question ${stepIndex + 1} of ${item.questions.length}`,
            }
          : {})}
      >
        {q.header && (
          <p className="text-xs font-semibold text-text-primary mb-1">
            {q.header}
          </p>
        )}
        <p className="text-sm text-text-secondary mb-2">{q.question}</p>
        <div
          role={q.multiSelect ? 'group' : 'radiogroup'}
          aria-label={q.question}
          className="space-y-1"
        >
          {q.options.map((opt, oIdx) =>
            renderOption(
              q,
              qIdx,
              oIdx,
              opt.label,
              opt.description,
              selectedSet.includes(opt.label),
              () => toggleOption(q.question, opt.label, q.multiSelect),
            ),
          )}
          {renderOption(
            q,
            qIdx,
            q.options.length,
            OTHER_LABEL,
            undefined,
            otherIsOn,
            () => toggleOther(q.question, q.multiSelect),
          )}
        </div>
        {otherIsOn && (
          <OtherInput
            workspaceId={workspaceId}
            value={otherText[q.question] || ''}
            disabled={isResolving}
            onChange={(v) => setOtherTextFor(q.question, v)}
          />
        )}
      </div>
    )
  }

  const isLastStep = stepIndex === item.questions.length - 1

  const questionContent = isStepper
    ? renderQuestion(currentQuestion, stepIndex)
    : item.questions.map((q, qIdx) => renderQuestion(q, qIdx))

  return (
    <div>
      {isResolving ? (
        <div className="flex items-center gap-2 mb-3 text-sm text-text-tertiary">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Submitted
        </div>
      ) : currentHasPreviews ? (
        <div className="flex gap-3 mb-3 max-h-[60vh]">
          <div className="flex-1 min-w-0 overflow-y-auto pr-1">
            {questionContent}
          </div>
          <div className="flex-1 min-w-0 bg-bg/50 border border-border/30 rounded-md overflow-hidden">
            <PreviewPane html={focusedPreview} />
          </div>
        </div>
      ) : (
        <div className="mb-3">{questionContent}</div>
      )}

      <div className="flex items-center gap-2">
        {isStepper && stepIndex > 0 && (
          <Button
            onClick={() => onStepChange(stepIndex - 1)}
            variant="secondary"
            size="sm"
          >
            Back
          </Button>
        )}
        {isStepper && !isLastStep && (
          <Button
            onClick={() => onStepChange(stepIndex + 1)}
            disabled={!canNext}
            size="sm"
          >
            Next
          </Button>
        )}
        {(!isStepper || isLastStep) && (
          <Button onClick={handleConfirm} disabled={!canConfirm} size="sm">
            {isResolving ? (
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                …
              </span>
            ) : (
              'Confirm'
            )}
          </Button>
        )}
        {hasPreviews && (
          <Button
            onClick={onChatAbout}
            disabled={isResolving}
            variant="secondary"
            size="sm"
          >
            Chat about this
          </Button>
        )}
      </div>
    </div>
  )
}

interface OtherInputProps {
  workspaceId: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}

function OtherInput({
  workspaceId,
  value,
  disabled,
  onChange,
}: OtherInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const commandHandleRef = useRef<CommandPickerHandle>(null)
  const fileHandleRef = useRef<FilePickerHandle>(null)
  const prevRef = useRef('')

  const [commandOpen, setCommandOpen] = useState(false)
  const [commandSource, setCommandSource] = useState<'slash' | 'button'>(
    'slash',
  )
  const [commandFilter, setCommandFilter] = useState('')

  const [fileOpen, setFileOpen] = useState(false)
  const [fileSource, setFileSource] = useState<'at' | 'button'>('at')
  const [fileFilter, setFileFilter] = useState('')
  const [fileTriggerStart, setFileTriggerStart] = useState<number | null>(
    null,
  )

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [value])

  const handleInputChange = (next: string, cursorPos: number) => {
    const prev = prevRef.current
    prevRef.current = next
    onChange(next)

    if (fileOpen) {
      if (fileTriggerStart !== null) {
        if (cursorPos <= fileTriggerStart || next[fileTriggerStart] !== '@') {
          setFileOpen(false)
          setFileTriggerStart(null)
          return
        }
        const filterText = next.slice(fileTriggerStart + 1, cursorPos)
        if (/\s/.test(filterText)) {
          setFileOpen(false)
          setFileTriggerStart(null)
          return
        }
        setFileFilter(filterText)
      }
    }

    if (commandOpen && commandSource === 'slash') {
      if (next === '') {
        setCommandOpen(false)
      } else if (next.startsWith('/') && !/\s/.test(next)) {
        setCommandFilter(next.slice(1))
      } else {
        setCommandOpen(false)
      }
    }

    // Detect @ trigger when no command picker is open
    if (!fileOpen && (!commandOpen || commandSource !== 'slash')) {
      if (next === '@' && prev === '') {
        setFileTriggerStart(0)
        setFileSource('at')
        setFileFilter('')
        setFileOpen(true)
        setCommandOpen(false)
        return
      }
      if (
        cursorPos > 0 &&
        next[cursorPos - 1] === '@' &&
        (cursorPos === 1 || /\s/.test(next[cursorPos - 2]))
      ) {
        setFileTriggerStart(cursorPos - 1)
        setFileSource('at')
        setFileFilter('')
        setFileOpen(true)
        setCommandOpen(false)
      }
    }

    // Detect slash trigger from empty
    if (
      !fileOpen &&
      !commandOpen &&
      prev === '' &&
      next.startsWith('/') &&
      !/\s/.test(next)
    ) {
      setCommandSource('slash')
      setCommandFilter(next.slice(1))
      setCommandOpen(true)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (fileOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        fileHandleRef.current?.moveDown()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        fileHandleRef.current?.moveUp()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        fileHandleRef.current?.commitActive()
        return
      }
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        setFileOpen(false)
        setFileTriggerStart(null)
        return
      }
    }

    if (commandOpen && commandSource === 'slash') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        commandHandleRef.current?.moveDown()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        commandHandleRef.current?.moveUp()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        commandHandleRef.current?.commitActive()
        return
      }
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        setCommandOpen(false)
        return
      }
    }

    // Enter inserts a newline (default browser behavior) — surface Confirm is a separate button.
  }

  const handleCommandSelect = (command: SlashCommandDto) => {
    const inserted = `/${command.name} `
    onChange(inserted)
    prevRef.current = inserted
    setCommandOpen(false)
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
    const before = value.slice(0, fileTriggerStart)
    const after = value.slice(cursorPos)
    const inserted = `@${selectedPath} `
    const next = before + inserted + after
    onChange(next)
    prevRef.current = next
    setFileOpen(false)
    setFileTriggerStart(null)
    requestAnimationFrame(() => {
      const pos = fileTriggerStart + inserted.length
      ta.focus()
      ta.setSelectionRange(pos, pos)
    })
  }

  const openCommandsExplicit = () => {
    if (commandOpen) {
      setCommandOpen(false)
      return
    }
    setFileOpen(false)
    setFileTriggerStart(null)
    setCommandSource('button')
    setCommandFilter('')
    setCommandOpen(true)
  }

  const openFilesExplicit = () => {
    if (fileOpen) {
      setFileOpen(false)
      setFileTriggerStart(null)
      return
    }
    setCommandOpen(false)
    setFileSource('button')
    setFileFilter('')
    setFileTriggerStart(null)
    setFileOpen(true)
  }

  return (
    <div className="mt-2 ml-5 relative bg-surface border border-border/60 rounded-md">
      <div className="flex items-center px-2 pt-1.5 gap-1">
        <CommandPicker
          ref={commandHandleRef}
          workspaceId={workspaceId}
          open={commandOpen}
          onOpenChange={setCommandOpen}
          onSelect={handleCommandSelect}
          side="top"
          align="start"
          initialFilter={commandFilter}
          hideFilterInput={commandSource === 'slash'}
          refetchOnOpen
          anchor={
            <button
              type="button"
              onClick={openCommandsExplicit}
              disabled={disabled}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Commands"
            >
              <SlashSquare className="w-3 h-3" />
              <span>Commands</span>
            </button>
          }
        />
        <FilePicker
          ref={fileHandleRef}
          workspaceId={workspaceId}
          open={fileOpen}
          onOpenChange={(open) => {
            setFileOpen(open)
            if (!open) setFileTriggerStart(null)
          }}
          onSelect={handleFileSelect}
          side="top"
          align="start"
          initialFilter={fileFilter}
          hideFilterInput={fileSource === 'at'}
          refetchOnOpen
          anchor={
            <button
              type="button"
              onClick={openFilesExplicit}
              disabled={disabled || !workspaceId}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Files"
            >
              <Paperclip className="w-3 h-3" />
              <span>Files</span>
            </button>
          }
        />
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) =>
          handleInputChange(e.target.value, e.target.selectionStart)
        }
        onKeyDown={handleKeyDown}
        placeholder="Type your answer…"
        disabled={disabled}
        rows={1}
        className="w-full bg-transparent border-0 px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:ring-0 overflow-y-auto"
        style={{ minHeight: '36px', maxHeight: '160px' }}
      />
    </div>
  )
}
