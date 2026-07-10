import { useEffect, useId, useState } from 'react'
import { ChevronDown, ChevronUp, CheckIcon, CopyIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { StructuredReportMeta } from '@/lib/structured-report'

import { cn } from '../ui/utils'
import {
  CodeBlockActions,
  CodeBlockContainer,
  CodeBlockContent,
  CodeBlockHeader,
} from './code-block'

/**
 * Above these thresholds the body renders as raw monospace (no shiki) so the
 * UI stays responsive and the highlighter's length-plus-edges cache key cannot
 * collide on huge JSON. Starting values; tune on real payloads. (R8, AE7)
 */
const HIGHLIGHT_CHAR_CAP = 200_000
const HIGHLIGHT_LINE_CAP = 5_000

/** Payloads at or below these bounds start expanded. (R4, AE1) */
const TINY_CHAR_CAP = 120
const TINY_LINE_CAP = 3

const COPY_RESET_MS = 2_000

export interface StructuredReportProps {
  /** Opaque parsed value. Accepted for forward-compat; never read for UI (R6). */
  value: unknown
  /** Pretty-printed JSON (`JSON.stringify(value, null, 2)`) shown in the body. */
  pretty: string
  meta: StructuredReportMeta
  /** Original text part; the copy action writes this for a lossless round-trip. */
  raw: string
  forceExpanded?: boolean
  hasSearchMatch?: boolean
  isCurrentSearchMatch?: boolean
}

function logCopyFailure(error: unknown) {
  try {
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'error',
        source: 'structured-report',
        message: 'Copy failed',
        error: String(error),
      }),
    })
  } catch {
    // Best-effort logging; a copy handler must never throw.
  }
}

export function StructuredReport({
  pretty,
  meta,
  raw,
  forceExpanded = false,
  hasSearchMatch = false,
  isCurrentSearchMatch = false,
}: StructuredReportProps) {
  const { t } = useTranslation('chat')
  const bodyId = useId()

  const lineCount = pretty.split('\n').length
  const overCap =
    pretty.length > HIGHLIGHT_CHAR_CAP || lineCount > HIGHLIGHT_LINE_CAP
  const isTiny = pretty.length <= TINY_CHAR_CAP || lineCount <= TINY_LINE_CAP

  const [expanded, setExpanded] = useState(
    () => forceExpanded || hasSearchMatch || isCurrentSearchMatch || isTiny,
  )
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (forceExpanded || hasSearchMatch || isCurrentSearchMatch) {
      setExpanded(true)
    }
  }, [forceExpanded, hasSearchMatch, isCurrentSearchMatch])

  const countLabel = t(
    meta.kind === 'array' ? 'structuredReport.items' : 'structuredReport.keys',
    { count: meta.count },
  )
  const sizeLabel = t('structuredReport.size', { size: meta.size })

  const toggle = () => setExpanded((value) => !value)

  const onCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      logCopyFailure(new Error('Clipboard API unavailable'))
      return
    }
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      window.setTimeout(() => setCopied(false), COPY_RESET_MS)
    } catch (error) {
      setCopied(false)
      logCopyFailure(error)
    }
  }

  const Chevron = expanded ? ChevronUp : ChevronDown
  const CopyGlyph = copied ? CheckIcon : CopyIcon

  return (
    <CodeBlockContainer
      language="json"
      hasSearchMatch={hasSearchMatch}
      isCurrentSearchMatch={isCurrentSearchMatch}
    >
      <CodeBlockHeader>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={
            expanded
              ? t('structuredReport.collapse')
              : t('structuredReport.expand')
          }
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-sm text-left',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          <Chevron className="h-3.5 w-3.5 shrink-0" />
          <span className="font-mono text-xs text-text-secondary">
            {t('structuredReport.label')}
          </span>
          <span className="text-text-tertiary">·</span>
          <span className="text-xs text-text-tertiary">{countLabel}</span>
          <span className="text-text-tertiary">·</span>
          <span className="text-xs text-text-tertiary">{sizeLabel}</span>
        </button>
        <CodeBlockActions>
          <button
            type="button"
            onClick={onCopy}
            aria-label={
              copied ? t('structuredReport.copied') : t('structuredReport.copy')
            }
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-hover hover:text-text-secondary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          >
            <CopyGlyph className="h-3.5 w-3.5" />
          </button>
        </CodeBlockActions>
      </CodeBlockHeader>
      <div id={bodyId} data-testid="structured-report-body" hidden={!expanded}>
        {expanded &&
          (overCap ? (
            <>
              <pre className="m-0 overflow-auto p-2 font-mono text-xs text-text-primary">
                {pretty}
              </pre>
              <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-tertiary">
                {t('structuredReport.highlightSkipped')}
              </div>
            </>
          ) : (
            <CodeBlockContent code={pretty} language="json" />
          ))}
      </div>
    </CodeBlockContainer>
  )
}
