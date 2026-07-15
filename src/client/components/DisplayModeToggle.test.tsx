import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import DisplayModeToggle from './DisplayModeToggle'
import { useAppSettings, resetAppSettings } from '../hooks/use-app-settings'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

/** A second component reading the same store — proves cross-component reactivity (R4). */
function ModeReader() {
  const { displayMode } = useAppSettings()
  return <div data-testid="reader">{displayMode}</div>
}

describe('DisplayModeToggle', () => {
  beforeEach(() => {
    localStorage.clear()
    resetAppSettings()
  })

  it('defaults to result-focused mode', () => {
    renderWithI18n(<ModeReader />)
    expect(screen.getByTestId('reader')).toHaveTextContent('result')
  })

  it('reflects result mode via aria-pressed and toggles to linear on click', () => {
    renderWithI18n(<DisplayModeToggle />)
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')

    const stored = JSON.parse(localStorage.getItem('app-settings') ?? '{}')
    expect(stored.displayMode).toBe('linear')
  })

  it('updates a separate consumer reactively without a reload (R4)', () => {
    renderWithI18n(
      <>
        <ModeReader />
        <DisplayModeToggle />
      </>,
    )
    expect(screen.getByTestId('reader')).toHaveTextContent('result')

    fireEvent.click(screen.getByRole('button'))
    // The separate consumer observed the store change and re-rendered.
    expect(screen.getByTestId('reader')).toHaveTextContent('linear')
    // Toggling back also propagates.
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('reader')).toHaveTextContent('result')
  })
})
