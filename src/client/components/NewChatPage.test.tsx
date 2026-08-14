import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import NewChatPage from './NewChatPage'
import { chooseDefaultNewChatWorkspace } from './new-chat-workspace'

const workspaces = [
  {
    id: 'ws-old',
    name: 'Older',
    description: '',
    folderPath: '/older',
    settings: {},
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'ws-new',
    name: 'Newest',
    description: '',
    folderPath: '/newest',
    settings: {},
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  },
]

function renderPage(props: Partial<React.ComponentProps<typeof NewChatPage>> = {}) {
  const defaults: React.ComponentProps<typeof NewChatPage> = {
    workspaces,
    defaultWorkspaceId: 'ws-old',
    onCreateWorkspace: vi.fn(),
    onSubmit: vi.fn(async () => {}),
  }
  return render(
    <I18nextProvider i18n={i18n}>
      <NewChatPage {...defaults} {...props} />
    </I18nextProvider>,
  )
}

describe('NewChatPage', () => {
  it('chooses the last session workspace, then the most recently opened or newest workspace', () => {
    expect(chooseDefaultNewChatWorkspace(workspaces, 'ws-old')).toBe('ws-old')
    expect(chooseDefaultNewChatWorkspace([
      { ...workspaces[0], lastOpenedAt: '2026-04-01T00:00:00.000Z' },
      { ...workspaces[1], lastOpenedAt: '2026-03-01T00:00:00.000Z' },
    ], null)).toBe('ws-old')
    expect(chooseDefaultNewChatWorkspace(workspaces, null)).toBe('ws-new')
  })

  it('submits the prompt with the selected workspace', async () => {
    const onSubmit = vi.fn(async () => {})
    renderPage({ onSubmit })

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-new' } })
    fireEvent.change(screen.getByPlaceholderText('What do you want to build?'), {
      target: { value: 'Fix the login redirect loop' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))

    expect(onSubmit).toHaveBeenCalledWith('ws-new', 'Fix the login redirect loop')
  })

  it('offers workspace creation from both the empty gate and populated selector', () => {
    const onCreateWorkspace = vi.fn()
    const { rerender } = renderPage({ workspaces: [], defaultWorkspaceId: null, onCreateWorkspace })

    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(onCreateWorkspace).toHaveBeenCalledTimes(1)

    rerender(
      <I18nextProvider i18n={i18n}>
        <NewChatPage
          workspaces={workspaces}
          defaultWorkspaceId="ws-old"
          onCreateWorkspace={onCreateWorkspace}
          onSubmit={vi.fn(async () => {})}
        />
      </I18nextProvider>,
    )
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: '__create_workspace__' } })
    expect(onCreateWorkspace).toHaveBeenCalledTimes(2)
  })

  it('selects a newly created workspace and keeps the prompt when submission fails', () => {
    const onSubmit = vi.fn(async () => {})
    const { rerender } = renderPage({ onSubmit })
    const prompt = screen.getByPlaceholderText('What do you want to build?')
    fireEvent.change(prompt, { target: { value: 'Keep this prompt' } })

    rerender(
      <I18nextProvider i18n={i18n}>
        <NewChatPage
          workspaces={[...workspaces, { ...workspaces[1], id: 'ws-created', name: 'Created' }]}
          defaultWorkspaceId="ws-old"
          selectedWorkspaceId="ws-created"
          onCreateWorkspace={vi.fn()}
          onSubmit={onSubmit}
          error="Creating the session timed out. Try again."
        />
      </I18nextProvider>,
    )

    expect(screen.getByLabelText('Workspace')).toHaveValue('ws-created')
    expect(screen.getByPlaceholderText('What do you want to build?')).toHaveValue('Keep this prompt')
    expect(screen.getByRole('alert')).toHaveTextContent('Creating the session timed out. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    expect(onSubmit).toHaveBeenCalledWith('ws-created', 'Keep this prompt')
  })
})
