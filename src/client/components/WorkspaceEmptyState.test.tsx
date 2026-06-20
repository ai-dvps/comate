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
  onBrowseWorkspaces: vi.fn(),
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

  it('does not show recent workspaces when the list is empty', () => {
    renderWithI18n(<WorkspaceEmptyState {...defaultProps} workspaces={[]} />)

    expect(
      screen.queryByText(/Recent workspaces/i),
    ).not.toBeInTheDocument()
  })

  it('lists existing workspaces and calls onSelectWorkspace when one is clicked', async () => {
    const user = userEvent.setup()
    const handleSelectWorkspace = vi.fn()
    const workspaces = [
      { id: 'ws1', name: 'Alpha', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'ws2', name: 'Beta', lastOpenedAt: '2026-01-02T00:00:00.000Z' },
    ]

    renderWithI18n(
      <WorkspaceEmptyState
        {...defaultProps}
        workspaces={workspaces}
        onSelectWorkspace={handleSelectWorkspace}
      />,
    )

    expect(
      screen.getByText(/Recent workspaces/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Beta' }))

    expect(handleSelectWorkspace).toHaveBeenCalledTimes(1)
    expect(handleSelectWorkspace).toHaveBeenCalledWith('ws2')
  })

  it('sorts workspaces by lastOpenedAt descending', () => {
    const workspaces = [
      { id: 'oldest', name: 'Oldest', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'newest', name: 'Newest', lastOpenedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'middle', name: 'Middle', lastOpenedAt: '2026-01-02T00:00:00.000Z' },
    ]

    renderWithI18n(
      <WorkspaceEmptyState {...defaultProps} workspaces={workspaces} />,
    )

    const buttons = screen.getAllByRole('button').filter((b) =>
      ['Oldest', 'Middle', 'Newest'].includes(b.textContent ?? ''),
    )
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Newest',
      'Middle',
      'Oldest',
    ])
  })

  it('falls back to updatedAt when lastOpenedAt is missing', () => {
    const workspaces = [
      { id: 'no-open', name: 'No Open', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'opened', name: 'Opened', lastOpenedAt: '2026-01-02T00:00:00.000Z' },
    ]

    renderWithI18n(
      <WorkspaceEmptyState {...defaultProps} workspaces={workspaces} />,
    )

    const buttons = screen.getAllByRole('button').filter((b) =>
      ['No Open', 'Opened'].includes(b.textContent ?? ''),
    )
    expect(buttons.map((b) => b.textContent)).toEqual(['Opened', 'No Open'])
  })

  it('caps the recent list at 5 workspaces and shows a browse-all link', () => {
    const workspaces = Array.from({ length: 7 }, (_, i) => ({
      id: `ws-${i}`,
      name: `Workspace ${i}`,
      lastOpenedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }))

    renderWithI18n(
      <WorkspaceEmptyState {...defaultProps} workspaces={workspaces} />,
    )

    expect(screen.getAllByRole('button').length).toBe(7) // create + 5 recent + browse
    expect(
      screen.getByRole('button', { name: 'Browse all workspaces' }),
    ).toBeInTheDocument()
  })

  it('calls onBrowseWorkspaces when the browse-all link is clicked', async () => {
    const user = userEvent.setup()
    const handleBrowseWorkspaces = vi.fn()
    const workspaces = Array.from({ length: 6 }, (_, i) => ({
      id: `ws-${i}`,
      name: `Workspace ${i}`,
      lastOpenedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }))

    renderWithI18n(
      <WorkspaceEmptyState
        {...defaultProps}
        workspaces={workspaces}
        onBrowseWorkspaces={handleBrowseWorkspaces}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Browse all workspaces' }),
    )

    expect(handleBrowseWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('does not show browse-all link when there are 5 or fewer workspaces', () => {
    const workspaces = Array.from({ length: 5 }, (_, i) => ({
      id: `ws-${i}`,
      name: `Workspace ${i}`,
      lastOpenedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }))

    renderWithI18n(
      <WorkspaceEmptyState {...defaultProps} workspaces={workspaces} />,
    )

    expect(
      screen.queryByRole('button', { name: 'Browse all workspaces' }),
    ).not.toBeInTheDocument()
  })
})
