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

const defaultProps = {
  onCreateWorkspace: vi.fn(),
  onSelectWorkspace: vi.fn(),
}

describe('WorkspaceEmptyState', () => {
  it('renders the headline, description, and create-workspace button', () => {
    renderWithI18n(<WorkspaceEmptyState {...defaultProps} />)

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
      <WorkspaceEmptyState
        {...defaultProps}
        onCreateWorkspace={handleCreateWorkspace}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Create workspace/i }))

    expect(handleCreateWorkspace).toHaveBeenCalledTimes(1)
  })

  it('does not show existing workspaces when the list is empty', () => {
    renderWithI18n(<WorkspaceEmptyState {...defaultProps} workspaces={[]} />)

    expect(
      screen.queryByText(/Or open an existing workspace/i),
    ).not.toBeInTheDocument()
  })

  it('lists existing workspaces and calls onSelectWorkspace when one is clicked', async () => {
    const user = userEvent.setup()
    const handleSelectWorkspace = vi.fn()
    const workspaces = [
      { id: 'ws1', name: 'Alpha' },
      { id: 'ws2', name: 'Beta' },
    ]

    renderWithI18n(
      <WorkspaceEmptyState
        {...defaultProps}
        workspaces={workspaces}
        onSelectWorkspace={handleSelectWorkspace}
      />,
    )

    expect(
      screen.getByText(/Or open an existing workspace/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Beta' }))

    expect(handleSelectWorkspace).toHaveBeenCalledTimes(1)
    expect(handleSelectWorkspace).toHaveBeenCalledWith('ws2')
  })
})
