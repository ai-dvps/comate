import { HelpCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function AskUserQuestionRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { questions } = input as Record<string, unknown>
  if (!Array.isArray(questions) || questions.length === 0) return null

  return (
    <div className="space-y-3">
      {questions.map((q, qi) => {
        if (typeof q !== 'object' || q === null) return null
        const question = q as Record<string, unknown>
        const text = typeof question.question === 'string' ? question.question : null
        const header = typeof question.header === 'string' ? question.header : null
        const isMulti = question.multiSelect === true
        const options = Array.isArray(question.options)
          ? question.options.filter(
              (o): o is { label?: string; description?: string } =>
                typeof o === 'object' && o !== null,
            )
          : []

        return (
          <div key={qi} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <HelpCircle className="size-3.5 text-text-tertiary shrink-0" />
              {header && (
                <span className="text-xs text-text-tertiary uppercase tracking-wide">
                  {header}
                </span>
              )}
              {isMulti && (
                <span className="text-xs text-accent">Multi-select</span>
              )}
            </div>
            {text && (
              <p className="text-sm text-text-secondary font-medium">{text}</p>
            )}
            {options.length > 0 && (
              <div className="pl-4 space-y-1">
                {options.map((opt, oi) => (
                  <div key={oi} className="flex flex-col gap-0.5">
                    <span className="text-sm text-text-primary">
                      {opt.label ?? `Option ${oi + 1}`}
                    </span>
                    {typeof opt.description === 'string' && (
                      <span className="text-xs text-text-tertiary">
                        {opt.description}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

registerToolRenderer('AskUserQuestion', AskUserQuestionRenderer)
