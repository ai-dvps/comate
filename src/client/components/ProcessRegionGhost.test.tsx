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
const toolWith = (
  name: string,
  input: unknown,
  timestamp?: number,
  isStreaming = false,
): RenderablePart =>
  ({ type: 'tool_use', toolUseId: name, toolName: name, input, isStreaming, timestamp })

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
    expect(screen.getByTestId('duration-visible').textContent).toBe('1s')
  })

  it('updates duration every second while streaming', () => {
    vi.setSystemTime(1000)
    const region = makeRegion([
      think('a', 0, true),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByTestId('duration-visible').textContent).toBe('1s')

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('duration-visible').textContent).toBe('2s')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByTestId('duration-visible').textContent).toBe('4s')
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
    expect(screen.getByTestId('duration-visible').textContent).toBe('4s')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByTestId('duration-visible').textContent).toBe('6s')

    act(() => {
      fireEvent.click(screen.getByTestId('complete'))
    })
    // Completion timestamp equals start here, so without snap-back guard it would show 0s.
    // We expect the last streaming value (6s) to be preserved.
    expect(screen.getByTestId('duration-visible').textContent).toBe('6s')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByTestId('duration-visible').textContent).toBe('6s')
  })

  it('shows a placeholder when timestamp data is unavailable', () => {
    const region = makeRegion([think('a')])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByTestId('duration-visible').textContent).toBe('—')
  })

  it('shows "less than 1s" for sub-second completed durations', () => {
    vi.setSystemTime(3000)
    const region = makeRegion([
      think('a', 1000),
      tool('Edit', 1500),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByTestId('duration-visible').textContent).toBe('less than 1s')
    expect(screen.getByTestId('duration-live').textContent).toBe('less than 1s')
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

  it('does not include duration in the button aria-label', () => {
    vi.setSystemTime(3000)
    const region = makeRegion([
      think('a', 1000),
      tool('Edit', 2000),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toMatch(/2 steps/)
    expect(button.getAttribute('aria-label')).toMatch(/Edit/)
    expect(button.getAttribute('aria-label')).not.toMatch(/1s/)
  })

  it('announces duration through a live region', () => {
    vi.setSystemTime(3000)
    const region = makeRegion([
      think('a', 1000),
      tool('Edit', 2000),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByTestId('duration-live').textContent).toBe('1s')
  })

  it('computes duration from the first defined timestamp', () => {
    vi.setSystemTime(3000)
    const region = makeRegion([
      think('a', undefined),
      tool('Bash', 1000),
      think('b', 2000),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByTestId('duration-visible').textContent).toBe('1s')
  })

  it('freezes duration at the last defined timestamp when trailing timestamps are missing', () => {
    vi.setSystemTime(5000)
    const region = makeRegion([
      think('a', 1000),
      tool('Bash', 2000),
      think('b', undefined),
    ])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByTestId('duration-visible').textContent).toBe('1s')
  })

  it('shows the latest tool key parameter next to its name (R1)', () => {
    const region = makeRegion([toolWith('Bash', { command: 'npm test' })])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    const button = screen.getByRole('button')
    expect(button.textContent).toContain('Bash')
    expect(button.textContent).toContain('npm test')
    expect(button.textContent).toContain('▸')
  })

  it('includes the key parameter in the aria-label (R6)', () => {
    const region = makeRegion([toolWith('Bash', { command: 'npm test' })])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/Bash ▸ npm test/)
  })

  it('shows the tool name only when there is no key parameter (R2)', () => {
    const region = makeRegion([toolWith('Task', { foo: 'bar' })])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    const button = screen.getByRole('button')
    expect(button.textContent).toContain('Task')
    expect(button.textContent).not.toContain('▸')
    expect(button.textContent).not.toContain('bar')
  })

  it('shows the tool name only while the latest tool is streaming (KTD4)', () => {
    const region = makeRegion([toolWith('Bash', { command: 'npm test' }, undefined, true)])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    const button = screen.getByRole('button')
    expect(button.textContent).toContain('Bash')
    expect(button.textContent).not.toContain('npm test')
    expect(button.textContent).not.toContain('▸')
  })

  it('left-truncates a long file path so the filename survives (AE2)', () => {
    const deep = `src/${'a/'.repeat(30)}BashRenderer.tsx`
    const region = makeRegion([toolWith('Edit', { file_path: deep })])
    renderWithI18n(<ProcessRegionGhost region={region} hasError={false} onOpen={() => {}} />)
    const button = screen.getByRole('button')
    expect(button.textContent).toContain('BashRenderer.tsx')
    expect(button.textContent).not.toContain(deep)
  })
})
