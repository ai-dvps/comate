import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import enChat from '../../i18n/en/chat.json'
import zhChat from '../../i18n/zh-CN/chat.json'
import { StructuredReport, type StructuredReportProps } from './structured-report'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; size?: number }) => {
      if (opts && typeof opts.count === 'number') {
        const isItems = key.endsWith('items')
        const unit = isItems
          ? opts.count === 1
            ? 'item'
            : 'items'
          : opts.count === 1
            ? 'key'
            : 'keys'
        return `${opts.count} ${unit}`
      }
      if (opts && typeof opts.size === 'number') {
        return `${opts.size} chars`
      }
      const labels: Record<string, string> = {
        'structuredReport.label': 'JSON',
        'structuredReport.expand': 'Expand JSON',
        'structuredReport.collapse': 'Collapse JSON',
        'structuredReport.copy': 'Copy JSON',
        'structuredReport.copied': 'Copied',
        'structuredReport.highlightSkipped':
          'Syntax highlighting skipped for a large payload',
        'structuredReport.copyFailed': 'Copy failed',
      }
      return labels[key] ?? key
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}))

vi.mock('../../hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

const bigValue = { a: 1, b: 'x'.repeat(120), c: 3 }
const bigPretty = JSON.stringify(bigValue, null, 2)
const bigRaw = JSON.stringify(bigValue)

const makeProps = (over: Partial<StructuredReportProps> = {}): StructuredReportProps => ({
  value: { a: 1 },
  pretty: '{\n  "a": 1\n}',
  meta: { kind: 'object', count: 1, size: 13 },
  raw: '{"a":1}',
  ...over,
})

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

describe('StructuredReport', () => {
  it('renders a collapsed header by default and expands to show the JSON body', async () => {
    render(
      <StructuredReport
        {...makeProps({
          value: bigValue,
          pretty: bigPretty,
          meta: { kind: 'object', count: 3, size: bigPretty.length },
          raw: bigRaw,
        })}
      />,
    )

    expect(screen.getByText('JSON')).toBeInTheDocument()
    expect(screen.getByText('3 keys')).toBeInTheDocument()

    const body = screen.getByTestId('structured-report-body')
    expect(body).not.toBeVisible()

    const toggle = screen.getByRole('button', { name: 'Expand JSON' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', body.id)

    await userEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(body).toBeVisible()
    expect(body.textContent).toContain('"b":')
  })

  it('starts expanded for a tiny payload', () => {
    render(<StructuredReport {...makeProps()} />)
    expect(screen.getByTestId('structured-report-body')).toBeVisible()
  })

  it('starts expanded when forceExpanded is set', () => {
    render(
      <StructuredReport
        {...makeProps({ pretty: bigPretty, meta: { kind: 'object', count: 3, size: bigPretty.length }, forceExpanded: true })}
      />,
    )
    expect(screen.getByTestId('structured-report-body')).toBeVisible()
  })

  it('starts expanded and rings on a search match', () => {
    render(
      <StructuredReport
        {...makeProps({
          pretty: bigPretty,
          meta: { kind: 'object', count: 3, size: bigPretty.length },
          hasSearchMatch: true,
        })}
      />,
    )
    expect(screen.getByTestId('structured-report-body')).toBeVisible()
    const container = document.querySelector('[data-language="json"]')
    expect(container).toHaveClass('ring-1')
  })

  it('shows "N items" for an array meta', () => {
    render(
      <StructuredReport
        {...makeProps({
          value: [1, 2, 3],
          pretty: '[\n  1,\n  2,\n  3\n]',
          meta: { kind: 'array', count: 3, size: 17 },
          raw: '[1,2,3]',
        })}
      />,
    )
    expect(screen.getByText('3 items')).toBeInTheDocument()
  })

  it.each([
    { kind: 'object' as const, count: 1, label: '1 key' },
    { kind: 'object' as const, count: 0, label: '0 keys' },
    { kind: 'object' as const, count: 2, label: '2 keys' },
    { kind: 'array' as const, count: 1, label: '1 item' },
    { kind: 'array' as const, count: 4, label: '4 items' },
  ])('pluralizes count $count $kind as "$label"', ({ kind, count, label }) => {
    render(
      <StructuredReport
        {...makeProps({
          meta: { kind, count, size: 2 },
          pretty: kind === 'array' ? '[]' : '{}',
        })}
      />,
    )
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders a ce-code-review-shaped payload as generic JSON with no schema-specific UI', () => {
    const value = {
      verdict: 'pass',
      requirements: [{ id: 'R1' }],
      residualRisks: [],
      summary: 'x'.repeat(120),
    }
    const pretty = JSON.stringify(value, null, 2)
    render(
      <StructuredReport
        {...makeProps({
          value,
          pretty,
          meta: { kind: 'object', count: 4, size: pretty.length },
          raw: JSON.stringify(value),
        })}
      />,
    )
    expect(screen.getByText('JSON')).toBeInTheDocument()
    expect(screen.getByText('4 keys')).toBeInTheDocument()
    expect(screen.queryByText(/verdict/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/requirements/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/residual/i)).not.toBeInTheDocument()
  })

  it('falls back to raw monospace and a skip note above the size cap', () => {
    const huge = 'x'.repeat(200_001)
    render(
      <StructuredReport
        {...makeProps({
          pretty: huge,
          meta: { kind: 'object', count: 1, size: huge.length },
          raw: huge,
          forceExpanded: true,
        })}
      />,
    )
    const body = screen.getByTestId('structured-report-body')
    expect(body).toBeVisible()
    expect(screen.getByText('Syntax highlighting skipped for a large payload')).toBeInTheDocument()
    expect(body.querySelector('pre')).toBeInTheDocument()
  })

  it('copies the raw text, not the pretty text', async () => {
    render(
      <StructuredReport
        {...makeProps({
          value: bigValue,
          pretty: bigPretty,
          meta: { kind: 'object', count: 3, size: bigPretty.length },
          raw: bigRaw,
        })}
      />,
    )
    const copyButton = screen.getByRole('button', { name: 'Copy JSON' })
    await userEvent.click(copyButton)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(bigRaw)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('reverts to idle and logs when the clipboard rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue({})
    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true })

    try {
      render(<StructuredReport {...makeProps()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Copy JSON' }))

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/log',
          expect.objectContaining({ method: 'POST' }),
        )
      })
      expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeInTheDocument()
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true })
    }
  })

  it('exposes real button semantics for expand and copy', () => {
    render(<StructuredReport {...makeProps()} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    for (const button of buttons) {
      expect(button).toHaveAttribute('type', 'button')
    }
  })

  it('ships structuredReport keys in both chat locales', () => {
    const en = enChat as { structuredReport?: Record<string, string> }
    const zh = zhChat as { structuredReport?: Record<string, string> }
    expect(en.structuredReport?.keys_other).toBeDefined()
    expect(en.structuredReport?.items_other).toBeDefined()
    expect(zh.structuredReport?.keys).toBeDefined()
    expect(zh.structuredReport?.items).toBeDefined()
    for (const key of ['label', 'size', 'expand', 'collapse', 'copy', 'copied', 'highlightSkipped']) {
      expect(en.structuredReport?.[key]).toBeDefined()
      expect(zh.structuredReport?.[key]).toBeDefined()
    }
  })
})
