import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MessageSearchBar from './MessageSearchBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('MessageSearchBar', () => {
  const baseProps = {
    query: '',
    onQueryChange: vi.fn(),
    currentMatchIndex: 0,
    totalMatches: 0,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    isSearching: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('focuses the input on mount', () => {
    render(<MessageSearchBar {...baseProps} />)
    expect(screen.getByRole('textbox')).toHaveFocus()
  })

  it('typing updates the query', () => {
    render(<MessageSearchBar {...baseProps} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'config' } })
    expect(baseProps.onQueryChange).toHaveBeenCalledWith('config')
  })

  it('displays the current and total match counts', () => {
    render(<MessageSearchBar {...baseProps} currentMatchIndex={2} totalMatches={5} />)
    expect(screen.getByText('3/5')).toBeInTheDocument()
  })

  it('shows 0/0 when there are no matches', () => {
    render(<MessageSearchBar {...baseProps} />)
    expect(screen.getByText('0/0')).toBeInTheDocument()
  })

  it('calls onNext and onPrev when buttons are clicked', () => {
    render(<MessageSearchBar {...baseProps} totalMatches={3} />)
    fireEvent.click(screen.getByLabelText('messageSearchNext'))
    expect(baseProps.onNext).toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('messageSearchPrevious'))
    expect(baseProps.onPrev).toHaveBeenCalled()
  })

  it('calls onClose when the close button is clicked', () => {
    render(<MessageSearchBar {...baseProps} />)
    fireEvent.click(screen.getByLabelText('messageSearchClose'))
    expect(baseProps.onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed in the input', () => {
    render(<MessageSearchBar {...baseProps} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(baseProps.onClose).toHaveBeenCalled()
  })

  it('calls onNext on Enter and onPrev on Shift+Enter', () => {
    render(<MessageSearchBar {...baseProps} totalMatches={3} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(baseProps.onNext).toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(baseProps.onPrev).toHaveBeenCalled()
  })

  it('clears the query when the clear button is clicked', () => {
    render(<MessageSearchBar {...baseProps} query="config" />)
    fireEvent.click(screen.getByLabelText('messageSearchClear'))
    expect(baseProps.onQueryChange).toHaveBeenCalledWith('')
  })

  it('shows a loading indicator while searching', () => {
    render(<MessageSearchBar {...baseProps} query="config" isSearching />)
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
  })
})
