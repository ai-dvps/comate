'use client'

import { HelpCircle, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Streamdown } from 'streamdown'

import { registerToolRenderer } from '../registry'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible'
import { cn } from '../../ui/utils'

function AskUserQuestionRendererComponent({
  input,
}: {
  input: unknown
}): ReactNode | null {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(true)

  if (!input || typeof input !== 'object') return null

  const { questions } = input as Record<string, unknown>
  if (!Array.isArray(questions) || questions.length === 0) return null

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center justify-between gap-2 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
      >
        <span className="flex items-center gap-2">
          <HelpCircle className="size-3.5 shrink-0" />
          <span className="text-xs uppercase tracking-wide">
            {t('askUserQuestion.title')}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 transition-transform',
            isOpen ? 'rotate-180' : 'rotate-0',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'mt-2 space-y-3',
          'data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
        )}
      >
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
                  <span className="text-xs text-accent">{t('askUserQuestion.multiSelect')}</span>
                )}
              </div>
              {text && (
                <div className="text-sm text-text-secondary font-medium">
                  <Streamdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
                    {text}
                  </Streamdown>
                </div>
              )}
              {options.length > 0 && (
                <div className="pl-4 space-y-1">
                  {options.map((opt, oi) => (
                    <div key={oi} className="flex flex-col gap-0.5">
                      <span className="text-sm text-text-primary">
                        {opt.label ?? t('askUserQuestion.optionFallback', { number: oi + 1 })}
                      </span>
                      {typeof opt.description === 'string' && (
                        <div className="text-xs text-text-tertiary">
                          <Streamdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
                            {opt.description}
                          </Streamdown>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}

export default function AskUserQuestionRenderer(input: unknown): ReactNode | null {
  return <AskUserQuestionRendererComponent input={input} />
}

registerToolRenderer('AskUserQuestion', AskUserQuestionRenderer)
