import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import NewChatPage from './NewChatPage'
import { chooseDefaultNewChatWorkspace } from './new-chat-workspace'

vi.mock('./PromptInput', () => ({
  default: ({
    workspaceId,
    mode,
    onSend,
    backendId,
    onBackendChange,
    providerId,
    onProviderChange,
    fastMode,
    onFastModeChange,
    approvalMode,
    onApprovalModeChange,
    disabled,
  }: {
    workspaceId: string
    mode?: string
    onSend: (turn: { text: string; images: [] }) => void
    backendId?: string | null
    onBackendChange?: (backendId: 'claude' | 'opencode') => void
    providerId?: string | null
    onProviderChange?: (providerId: string | null) => void
    fastMode?: boolean
    onFastModeChange?: (fastMode: boolean) => void
    approvalMode?: 'auto' | 'readonly' | 'manual'
    onApprovalModeChange?: (approvalMode: 'auto' | 'readonly' | 'manual') => void
    disabled?: boolean
  }) => (
    <div
      data-testid="prompt-input"
      data-workspace-id={workspaceId}
      data-mode={mode}
      data-backend-id={backendId ?? ''}
      data-provider-id={providerId ?? ''}
      data-fast-mode={fastMode ? 'true' : 'false'}
      data-approval-mode={approvalMode ?? ''}
    >
      <textarea aria-label="Prompt" disabled={disabled} />
      <button type="button" onClick={() => onBackendChange?.('opencode')}>Choose agent</button>
      <button type="button" onClick={() => onProviderChange?.('provider-2')}>Choose provider</button>
      <button type="button" onClick={() => onFastModeChange?.(!fastMode)}>Toggle fast</button>
      <button type="button" onClick={() => onApprovalModeChange?.('auto')}>Choose permission</button>
      <button type="button" disabled={disabled} onClick={() => onSend({ text: 'Fix the login redirect loop', images: [] })}>Send</button>
    </div>
  ),
}))

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
    onWorkspaceChange: vi.fn(),
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
    function ControlledPage() {
      const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
      return (
        <NewChatPage
          workspaces={workspaces}
          defaultWorkspaceId="ws-old"
          selectedWorkspaceId={selectedWorkspaceId}
          onWorkspaceChange={setSelectedWorkspaceId}
          onCreateWorkspace={vi.fn()}
          onSubmit={onSubmit}
        />
      )
    }
    render(
      <I18nextProvider i18n={i18n}>
        <ControlledPage />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choose provider' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle fast' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose permission' }))
    expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-provider-id', 'provider-2')
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Newest' }))
    expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-provider-id', '')
    fireEvent.click(screen.getByRole('button', { name: 'Choose provider' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle fast' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose permission' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSubmit).toHaveBeenCalledWith('ws-new', { text: 'Fix the login redirect loop', images: [] }, {
      backend: 'opencode',
      providerId: 'provider-2',
      fastMode: true,
      approvalMode: 'auto',
    })
  })

  it('uses the session PromptInput in new-chat mode', () => {
    renderPage()

    expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-mode', 'new-chat')
    expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-workspace-id', 'ws-old')
    const workspaceSelector = screen.getByRole('button', { name: 'Workspace' })
    const promptInput = screen.getByTestId('prompt-input')
    expect(screen.getByTestId('new-chat-composer')).toContainElement(workspaceSelector)
    expect(screen.getByTestId('new-chat-composer')).toContainElement(promptInput)
    expect(screen.getByTestId('new-chat-workspace-context')).toHaveClass('mx-4')
    expect(workspaceSelector.compareDocumentPosition(promptInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('fills the available pane so the composer container stays horizontally centered', () => {
    const { rerender } = renderPage()

    expect(screen.getByTestId('new-chat-page')).toHaveClass('w-full', 'flex-col', 'items-center')
    expect(screen.getByTestId('new-chat-composer-dock')).toHaveClass('w-full', 'max-w-3xl', 'shrink-0')

    rerender(
      <I18nextProvider i18n={i18n}>
        <NewChatPage
          workspaces={[]}
          defaultWorkspaceId={null}
          onWorkspaceChange={vi.fn()}
          onCreateWorkspace={vi.fn()}
          onSubmit={vi.fn(async () => {})}
        />
      </I18nextProvider>,
    )
    expect(screen.getByTestId('new-chat-workspace-gate')).toHaveClass('w-full')
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
          onWorkspaceChange={vi.fn()}
          onCreateWorkspace={onCreateWorkspace}
          onSubmit={vi.fn(async () => {})}
        />
      </I18nextProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Create workspace…' }))
    expect(onCreateWorkspace).toHaveBeenCalledTimes(2)
  })

  it('keeps long workspace menus scrollable above the bottom composer', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    expect(screen.getByTestId('new-chat-workspace-options')).toHaveClass('max-h-64', 'overflow-y-auto')
  })

  it('selects a newly created workspace and keeps the composer available when submission fails', () => {
    const onSubmit = vi.fn(async () => {})
    const { rerender } = renderPage({ onSubmit })

    rerender(
      <I18nextProvider i18n={i18n}>
        <NewChatPage
          workspaces={[...workspaces, { ...workspaces[1], id: 'ws-created', name: 'Created' }]}
          defaultWorkspaceId="ws-old"
          selectedWorkspaceId="ws-created"
          onWorkspaceChange={vi.fn()}
          onCreateWorkspace={vi.fn()}
          onSubmit={onSubmit}
          error="Creating the session timed out. Try again."
        />
      </I18nextProvider>,
    )

    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveTextContent('Created')
    expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-workspace-id', 'ws-created')
    expect(screen.getByRole('alert')).toHaveTextContent('Creating the session timed out. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).toHaveBeenCalledWith('ws-created', { text: 'Fix the login redirect loop', images: [] }, {
      backend: undefined,
      providerId: undefined,
      fastMode: false,
      approvalMode: 'manual',
    })
  })
})
