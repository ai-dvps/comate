import { useState, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { QuestionPayload } from '../types/message'

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

interface ApprovalBannerProps {
  pendingItem: PendingApproval | PendingQuestion | null
  queueDepth: number
  isResolving?: boolean
  onAllow: () => void
  onAllowAlways: () => void
  onDeny: (message: string) => void
  onAnswerQuestion: (answers: Record<string, string>) => void
}

export default function ApprovalBanner({
  pendingItem,
  queueDepth,
  isResolving = false,
  onAllow,
  onAllowAlways,
  onDeny,
  onAnswerQuestion,
}: ApprovalBannerProps) {
  if (!pendingItem) return null

  const isQuestion = 'questions' in pendingItem

  return (
    <div className="max-w-3xl mx-auto px-4 pt-3">
      <div className="bg-surface border border-border/50 rounded-lg px-4 py-3">
        {isQuestion ? (
          <QuestionView
            item={pendingItem as PendingQuestion}
            queueDepth={queueDepth}
            isResolving={isResolving}
            onAnswerQuestion={onAnswerQuestion}
          />
        ) : (
          <ApprovalView
            item={pendingItem as PendingApproval}
            queueDepth={queueDepth}
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

function ApprovalView({
  item,
  queueDepth,
  isResolving,
  onAllow,
  onAllowAlways,
  onDeny,
}: {
  item: PendingApproval
  queueDepth: number
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

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">
            {item.title || item.toolName}
          </span>
          {item.description && (
            <span className="text-xs text-text-secondary">
              {item.description}
            </span>
          )}
        </div>
        {queueDepth > 0 && (
          <span className="text-xs text-text-tertiary">
            1 of {queueDepth + 1}
          </span>
        )}
      </div>

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
        <button
          onClick={onAllow}
          disabled={isResolving}
          className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded-md transition-colors disabled:opacity-50"
        >
          {isResolving ? (
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              …
            </span>
          ) : (
            'Allow'
          )}
        </button>
        {hasSuggestions && (
          <button
            onClick={onAllowAlways}
            disabled={isResolving}
            className="px-3 py-1.5 text-xs font-medium text-text-primary bg-surface-hover hover:bg-border rounded-md transition-colors disabled:opacity-50"
          >
            Allow always
          </button>
        )}
        <button
          onClick={() => onDeny('User denied this tool call.')}
          disabled={isResolving}
          className="px-3 py-1.5 text-xs font-medium text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function QuestionView({
  item,
  queueDepth,
  isResolving,
  onAnswerQuestion,
}: {
  item: PendingQuestion
  queueDepth: number
  isResolving: boolean
  onAnswerQuestion: (answers: Record<string, string>) => void
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})

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
        return { ...prev, [questionText]: next }
      })
    },
    [],
  )

  const allAnswered = item.questions.every((q) => {
    const selected = selections[q.question] || []
    return selected.length > 0
  })

  const handleConfirm = () => {
    const answers: Record<string, string> = {}
    for (const q of item.questions) {
      const selected = selections[q.question] || []
      answers[q.question] = selected.join(', ')
    }
    onAnswerQuestion(answers)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-text-primary">
          Clarifying question
        </span>
        {queueDepth > 0 && (
          <span className="text-xs text-text-tertiary">
            1 of {queueDepth + 1}
          </span>
        )}
      </div>

      <div className="space-y-3 mb-3">
        {item.questions.map((q) => (
          <div key={q.question}>
            {q.header && (
              <p className="text-xs font-semibold text-text-primary mb-1">
                {q.header}
              </p>
            )}
            <p className="text-sm text-text-secondary mb-2">{q.question}</p>
            <div className="space-y-1">
              {q.options.map((opt) => {
                const selected = (selections[q.question] || []).includes(
                  opt.label,
                )
                return (
                  <button
                    key={opt.label}
                    onClick={() =>
                      toggleOption(q.question, opt.label, q.multiSelect)
                    }
                    disabled={isResolving}
                    className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                      selected
                        ? 'bg-accent/10 text-accent border border-accent/30'
                        : 'bg-bg text-text-secondary border border-border/50 hover:border-border'
                    } disabled:opacity-50`}
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
                            className="w-2.5 h-2.5 text-white"
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
                      <span className="font-medium">{opt.label}</span>
                    </div>
                    {opt.description && (
                      <p className="mt-0.5 ml-5.5 text-text-tertiary">
                        {opt.description}
                      </p>
                    )}
                    {opt.preview && (
                      <p className="mt-0.5 ml-5.5 text-text-tertiary italic">
                        {opt.preview}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={handleConfirm}
        disabled={isResolving || !allAnswered}
        className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded-md transition-colors disabled:opacity-50"
      >
        {isResolving ? (
          <span className="flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" />
            …
          </span>
        ) : (
          'Confirm'
        )}
      </button>
    </div>
  )
}
