import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { ChatEmptyState } from './ChatEmptyState'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('ChatEmptyState', () => {
  it('renders the headline, description, and start-chatting button', () => {
    renderWithI18n(<ChatEmptyState onCreateSession={vi.fn()} />)

    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
    expect(
      screen.getByText(/Send a message to begin chatting/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Start chatting/i }),
    ).toBeInTheDocument()
  })

  it('calls onCreateSession when the button is clicked', async () => {
    const user = userEvent.setup()
    const handleCreateSession = vi.fn()

    renderWithI18n(
      <ChatEmptyState onCreateSession={handleCreateSession} />,
    )

    await user.click(screen.getByRole('button', { name: /Start chatting/i }))

    expect(handleCreateSession).toHaveBeenCalledTimes(1)
  })
})
