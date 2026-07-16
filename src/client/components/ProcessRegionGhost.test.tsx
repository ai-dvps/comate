import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { useState } from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import ProcessRegionGhost from './ProcessRegionGhost'
import type { ProcessRegion } from './message-grouping'
import type { RenderablePart } from './chat-message-adapter'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const think = (text = 'hmm', timestamp?: number, isStreaming = false): RenderablePart =>
  ({ type: 'thinking', text, isStreaming, timestamp })
const tool = (name: string, timestamp?: number, isStreaming = false): RenderablePart =>
  ({ type: 'tool_use', toolUseId: name, toolName: name, input: {}, isStreaming, timestamp })

function makeRegion(parts: RenderablePart[]): ProcessRegion {
  return {
    type: 'process',
    parts,
    latest: parts[parts.length - 1],
    partIndices: parts.map((_, i) => i),
    timestamps: parts.map((p) => p.timestamp),
  }
}

describe('ProcessRegionGhost', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows formatted elapsed duration for a completed region', () => {
    vi.setSystemTime(3000)
    const region = makeRegion([
      think('a', 1000),
      tool('Bash', 2000),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByText('1s')).toBeInTheDocument()
  })

  it('updates duration every second while streaming', () => {
    vi.setSystemTime(1000)
    const region = makeRegion([
      think('a', 0, true),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByText('1s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('2s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('4s')).toBeInTheDocument()
  })

  it('freezes duration when streaming completes', () => {
    vi.setSystemTime(5000)

    function Wrapper() {
      const [isStreaming, setIsStreaming] = useState(true)
      return (
        <>
          <ProcessRegionGhost
            region={makeRegion([think('a', 1000, isStreaming)])}
            hasError={false}
            onOpen={() => {}}
          />
          <button
            type="button"
            data-testid="complete"
            onClick={() => setIsStreaming(false)}
          >
            complete
          </button>
        </>
      )
    }

    renderWithI18n(<Wrapper />)
    expect(screen.getByText('4s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('6s')).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByTestId('complete'))
    })
    // Completion timestamp equals start here, so without snap-back guard it would show 0s.
    // We expect the last streaming value (6s) to be preserved.
    expect(screen.getByText('6s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('6s')).toBeInTheDocument()
  })

  it('shows a placeholder when timestamp data is unavailable', () => {
    const region = makeRegion([think('a')])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders duration between step count and latest step label', () => {
    vi.setSystemTime(3000)
    const region = makeRegion([
      think('a', 1000),
      tool('Edit', 2000),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    const button = screen.getByRole('button')
    const textContent = button.textContent ?? ''
    const stepsIndex = textContent.indexOf('2 steps')
    const durationIndex = textContent.indexOf('1s')
    const labelIndex = textContent.indexOf('Edit')
    expect(stepsIndex).toBeGreaterThan(-1)
    expect(durationIndex).toBeGreaterThan(-1)
    expect(labelIndex).toBeGreaterThan(-1)
    expect(durationIndex).toBeGreaterThan(stepsIndex)
    expect(labelIndex).toBeGreaterThan(durationIndex)
  })

  it('includes duration in the accessible label', () => {
    vi.setSystemTime(3000)
    const region = makeRegion([
      think('a', 1000),
      tool('Edit', 2000),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toMatch(/1s/)
    expect(button.getAttribute('aria-label')).toMatch(/2 steps/)
    expect(button.getAttribute('aria-label')).toMatch(/Edit/)
  })
})
