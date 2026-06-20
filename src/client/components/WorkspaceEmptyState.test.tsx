import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { WorkspaceEmptyState } from './WorkspaceEmptyState'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('WorkspaceEmptyState', () => {
  it('renders the headline, description, and create-workspace button', () => {
    renderWithI18n(<WorkspaceEmptyState onCreateWorkspace={vi.fn()} />)

    expect(screen.getByText('Welcome to Comate')).toBeInTheDocument()
    expect(
      screen.getByText(/A workspace is a project folder/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Create workspace/i }),
    ).toBeInTheDocument()
  })

  it('calls onCreateWorkspace when the button is clicked', async () => {
    const user = userEvent.setup()
    const handleCreateWorkspace = vi.fn()

    renderWithI18n(
      <WorkspaceEmptyState onCreateWorkspace={handleCreateWorkspace} />,
    )

    await user.click(screen.getByRole('button', { name: /Create workspace/i }))

    expect(handleCreateWorkspace).toHaveBeenCalledTimes(1)
  })
})
