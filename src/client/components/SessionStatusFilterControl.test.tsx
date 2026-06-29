import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import SessionStatusFilterControl from './SessionStatusFilterControl'
import i18n from '../i18n'
import type { SessionStatusFilter } from '../lib/session-filter'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const LABEL = 'Filter sessions'

describe('SessionStatusFilterControl', () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    cleanup()
  })

  function renderControl(value: SessionStatusFilter = 'active', onChange = vi.fn(), disabled = false) {
    return renderWithI18n(
      <SessionStatusFilterControl
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-label={LABEL}
      />,
    )
  }

  it('renders the trigger with the icon and chevron', () => {
    renderControl('archived')
    const trigger = screen.getByRole('button', { name: LABEL })
    expect(trigger).toBeInTheDocument()
    expect(trigger.querySelectorAll('svg')).toHaveLength(2)
  })

  it('has aria-expanded false when closed and true when open', async () => {
    const user = userEvent.setup()
    renderControl()

    const trigger = screen.getByRole('button', { name: LABEL })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    await screen.findByRole('listbox')

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('is not interactive when disabled', () => {
    renderControl('active', vi.fn(), true)

    const trigger = screen.getByRole('button', { name: LABEL })
    expect(trigger).toBeDisabled()
  })

  it('opens the popover and shows the four options in order', async () => {
    const user = userEvent.setup()
    renderControl()

    await user.click(screen.getByRole('button', { name: LABEL }))
    const listbox = await screen.findByRole('listbox')
    expect(listbox).toHaveAttribute('aria-label', LABEL)

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['All', 'Active', 'Archived', 'WIP'])
  })

  it('marks the current value as selected with a visible checkmark', async () => {
    const user = userEvent.setup()
    renderControl('archived')

    await user.click(screen.getByRole('button', { name: LABEL }))
    await screen.findByRole('listbox')

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    expect(options[2]).toHaveAttribute('aria-selected', 'true')
    expect(options[3]).toHaveAttribute('aria-selected', 'false')

    const activeCheck = options[2].querySelector('.lucide-check')
    expect(activeCheck).toHaveClass('opacity-100')
  })

  it('calls onChange and closes the popover when an option is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControl('active', onChange)

    await user.click(screen.getByRole('button', { name: LABEL }))
    const option = await screen.findByRole('option', { name: /Archived/i })
    await user.click(option)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('archived')
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })

  it('does not call onChange when the already-selected option is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControl('active', onChange)

    await user.click(screen.getByRole('button', { name: LABEL }))
    const option = await screen.findByRole('option', { name: /Active/i })
    await user.click(option)

    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })

  it('opens the popover when Enter is pressed on the focused trigger', async () => {
    const user = userEvent.setup()
    renderControl()

    const trigger = screen.getByRole('button', { name: LABEL })
    trigger.focus()
    await user.keyboard('{Enter}')

    await screen.findByRole('listbox')
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('opens the popover when ArrowDown is pressed on the focused trigger', async () => {
    const user = userEvent.setup()
    renderControl()

    const trigger = screen.getByRole('button', { name: LABEL })
    trigger.focus()
    await user.keyboard('{ArrowDown}')

    await screen.findByRole('listbox')
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('moves focus through options with ArrowDown and ArrowUp and selects with Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControl('active', onChange)

    const trigger = screen.getByRole('button', { name: LABEL })
    trigger.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    // Move from Active down to Archived.
    await user.keyboard('{ArrowDown}')
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent('Archived')
    })

    // Move down to WIP and back up to Archived.
    await user.keyboard('{ArrowDown}')
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent('WIP')
    })

    await user.keyboard('{ArrowUp}')
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent('Archived')
    })

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('archived')
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })

  it('supports Home and End to jump focus', async () => {
    const user = userEvent.setup()
    renderControl('active')

    const trigger = screen.getByRole('button', { name: LABEL })
    trigger.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    await user.keyboard('{End}')
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent('WIP')
    })

    await user.keyboard('{Home}')
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent('All')
    })
  })

  it('wraps focus from last to first and first to last', async () => {
    const user = userEvent.setup()
    renderControl('all')

    const trigger = screen.getByRole('button', { name: LABEL })
    trigger.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')

    await user.keyboard('{ArrowUp}')
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent('WIP')
    })

    await user.keyboard('{ArrowDown}')
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent('All')
    })
  })

  it('closes the popover with Escape without calling onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControl('active', onChange)

    await user.click(screen.getByRole('button', { name: LABEL }))
    await screen.findByRole('listbox')

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('returns focus to the trigger after the popover closes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderControl('active', onChange)

    const trigger = screen.getByRole('button', { name: LABEL })
    await user.click(trigger)
    const option = await screen.findByRole('option', { name: /Archived/i })
    await user.click(option)

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger)
    })
  })
})
