import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import i18n from '../../i18n'
import { DateTimeField, TimeField } from './date-time-field'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

afterEach(cleanup)

describe('DateTimeField', () => {
  it('renders the formatted value on the trigger', () => {
    renderWithI18n(<DateTimeField value="2026-07-25T14:30" onChange={() => {}} />)
    expect(screen.getByText('2026-07-25 14:30')).toBeTruthy()
  })

  it('opens the calendar and commits the clicked day while preserving time', () => {
    const onChange = vi.fn()
    renderWithI18n(<DateTimeField value="2026-07-25T14:30" onChange={onChange} />)
    fireEvent.click(screen.getByText('2026-07-25 14:30'))
    // July 2026: the 10th is in the same month and not disabled (no min)
    fireEvent.click(within(screen.getByTestId('dtf-calendar')).getByText('10'))
    expect(onChange).toHaveBeenCalledWith('2026-07-10T14:30')
  })

  it('disables days before min', () => {
    const onChange = vi.fn()
    const min = new Date(2026, 6, 24, 9, 0)
    renderWithI18n(<DateTimeField value="2026-07-25T14:30" onChange={onChange} min={min} />)
    fireEvent.click(screen.getByText('2026-07-25 14:30'))
    const day20 = within(screen.getByTestId('dtf-calendar')).getByText('20')
    expect(day20).toHaveProperty('disabled', true)
    fireEvent.click(day20)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('navigates months with the chevrons', () => {
    renderWithI18n(<DateTimeField value="2026-07-25T14:30" onChange={() => {}} />)
    fireEvent.click(screen.getByText('2026-07-25 14:30'))
    const header = document.querySelector('.text-xs.font-medium')!
    const before = header.textContent
    fireEvent.click(screen.getByLabelText('next month'))
    expect(header.textContent).not.toBe(before)
  })

  it('commits time changes from the hour/minute columns', () => {
    const onChange = vi.fn()
    renderWithI18n(<DateTimeField value="2026-07-25T14:30" onChange={onChange} />)
    fireEvent.click(screen.getByText('2026-07-25 14:30'))
    const timeCols = screen.getByTestId('dtf-time')
    fireEvent.click(within(timeCols.children[0] as HTMLElement).getByText('08'))
    expect(onChange).toHaveBeenCalledWith('2026-07-25T08:30')
  })
})

describe('TimeField', () => {
  it('shows the value and commits hour selection', () => {
    const onChange = vi.fn()
    renderWithI18n(<TimeField value="09:05" onChange={onChange} />)
    fireEvent.click(screen.getByText('09:05'))
    const timeCols = screen.getByTestId('dtf-time')
    fireEvent.click(within(timeCols.children[0] as HTMLElement).getByText('18'))
    expect(onChange).toHaveBeenCalledWith('18:05')
  })
})
