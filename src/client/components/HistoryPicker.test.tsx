import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import HistoryPicker, { type HistoryPickerHandle } from './HistoryPicker'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

let mockPrompts: string[] = []

vi.mock('../hooks/useSentPrompts', () => ({
  useSentPrompts: () => mockPrompts,
}))

describe('HistoryPicker', () => {
  beforeEach(() => {
    mockPrompts = []
    cleanup()
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  function renderPicker(props: Partial<React.ComponentProps<typeof HistoryPicker>> = {}) {
    const handleSelect = vi.fn()
    const handleOpenChange = vi.fn()
    const ref = React.createRef<HistoryPickerHandle>()

    renderWithI18n(
      <HistoryPicker
        ref={ref}
        workspaceId="ws-1"
        open={true}
        onOpenChange={handleOpenChange}
        onSelect={handleSelect}
        anchor={<button type="button">History</button>}
        initialFilter=""
        {...props}
      />,
    )

    return { handleSelect, handleOpenChange, ref }
  }

  it('lists prompts in reverse chronological order', () => {
    // useSentPrompts returns prompts newest-first; mock that order directly.
    mockPrompts = ['third', 'second', 'first']
    renderPicker()

    const buttons = screen.getAllByRole('button')
    // First button is the anchor, subsequent buttons are rows.
    expect(buttons[1]).toHaveTextContent('third')
    expect(buttons[2]).toHaveTextContent('second')
    expect(buttons[3]).toHaveTextContent('first')
  })

  it('filters prompts with fuzzy matching', () => {
    mockPrompts = ['explain the function', 'compact session', 'commit changes']
    renderPicker({ initialFilter: 'exp' })

    expect(screen.getByText('explain the function')).toBeInTheDocument()
    expect(screen.queryByText('compact session')).not.toBeInTheDocument()
  })

  it('filters prompts with glob matching', () => {
    mockPrompts = ['fix the bug', 'explain the function', 'refactor parser']
    renderPicker({ initialFilter: '*fix*' })

    expect(screen.getByText('fix the bug')).toBeInTheDocument()
    expect(screen.queryByText('explain the function')).not.toBeInTheDocument()
  })

  it('selects the active prompt on Enter', () => {
    mockPrompts = ['only prompt']
    const { handleSelect, handleOpenChange } = renderPicker()
    const input = screen.getByPlaceholderText(/Search history/i)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(handleSelect).toHaveBeenCalledWith('only prompt')
    expect(handleOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes on Escape', () => {
    mockPrompts = ['only prompt']
    const { handleOpenChange } = renderPicker()
    const input = screen.getByPlaceholderText(/Search history/i)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(handleOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a line-count badge for multi-line prompts', () => {
    mockPrompts = ['line one\nline two\nline three']
    renderPicker()

    expect(screen.getByText(/line one/)).toBeInTheDocument()
    expect(screen.getByText(/\+2 more lines/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no prompts', () => {
    renderPicker()
    expect(screen.getByText(/No sent prompts yet/i)).toBeInTheDocument()
  })

  it('exposes moveDown / moveUp / commitActive via ref', () => {
    mockPrompts = ['a', 'b']
    const { handleSelect, ref } = renderPicker()

    act(() => {
      ref.current?.moveDown()
      ref.current?.commitActive()
    })
    expect(handleSelect).toHaveBeenCalledWith('a')
  })
})
