import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import CommandPicker, { type CommandPickerHandle } from './CommandPicker'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

vi.mock('../stores/commands-store', () => ({
  useCommands: () => ({
    commands: [
      { name: 'commit', description: 'Commit changes' },
      { name: 'compact', description: 'Compact session' },
    ],
    loading: false,
    error: undefined,
    partial: false,
    partialReason: undefined,
    fetch: vi.fn(),
    refresh: vi.fn(),
  }),
}))

describe('CommandPicker', () => {
  beforeEach(() => {
    cleanup()
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  function renderPicker(props: Partial<React.ComponentProps<typeof CommandPicker>> = {}) {
    const handleSelect = vi.fn()
    const handleOpenChange = vi.fn()
    const ref = React.createRef<CommandPickerHandle>()

    renderWithI18n(
      <CommandPicker
        ref={ref}
        workspaceId="ws-1"
        open={true}
        onOpenChange={handleOpenChange}
        onSelect={handleSelect}
        anchor={<button type="button">Commands</button>}
        initialFilter=""
        {...props}
      />,
    )

    return { handleSelect, handleOpenChange, ref }
  }

  it('applies contentWidth to the popover', () => {
    renderPicker({ contentWidth: 480 })
    const input = screen.getByPlaceholderText(/Search commands/i)
    const popover = input.parentElement

    expect(popover).toHaveClass('w-full')
    expect(popover).not.toHaveClass('w-[360px]')
    expect(popover).toHaveStyle({ width: '480px', boxSizing: 'border-box' })
  })

  it('falls back to fixed width when contentWidth is omitted', () => {
    renderPicker()
    const input = screen.getByPlaceholderText(/Search commands/i)
    const popover = input.parentElement

    expect(popover).toHaveClass('w-[360px]')
    expect(popover).not.toHaveClass('w-full')
    expect(popover).not.toHaveStyle({ width: '480px' })
  })
})
