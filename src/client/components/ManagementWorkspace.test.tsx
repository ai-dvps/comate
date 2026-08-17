import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ManagementWorkspace from './ManagementWorkspace'

vi.mock('./TodosPanel', () => ({ default: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div>Todos content</div> : null }))
vi.mock('./AnalyticsPanel', () => ({ default: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div>Analytics content</div> : null }))
vi.mock('./SettingsPanel', () => ({ default: ({ isOpen, initialWorkspaceId }: { isOpen: boolean; initialWorkspaceId?: string }) => isOpen ? <div>Settings content{initialWorkspaceId ? `:${initialWorkspaceId}` : ''}</div> : null }))
vi.mock('./PluginSettingsPage', () => ({ default: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div>Plugin content</div> : null }))
vi.mock('./SkillsPage', () => ({ default: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div>Skills content</div> : null }))

describe('ManagementWorkspace', () => {
  it('renders a first-level management destination', () => {
    render(<ManagementWorkspace destination="todos" onClose={vi.fn()} />)
    expect(screen.getByText('Todos content')).toBeInTheDocument()
  })

  it('combines Plugins and Skills in one capability destination', () => {
    render(<ManagementWorkspace destination="capabilities" workspaceId="ws-1" onClose={vi.fn()} />)
    expect(screen.getByText('Plugin content')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /skills/i }))
    expect(screen.getByText('Skills content')).toBeInTheDocument()
  })

  it('threads the settings workspace target into SettingsPanel as its initial selection', () => {
    render(<ManagementWorkspace destination="settings" settingsWorkspaceId="ws-9" onClose={vi.fn()} />)
    expect(screen.getByText('Settings content:ws-9')).toBeInTheDocument()
  })

  it('opens settings without a target when none is given', () => {
    render(<ManagementWorkspace destination="settings" onClose={vi.fn()} />)
    expect(screen.getByText('Settings content')).toBeInTheDocument()
  })
})
