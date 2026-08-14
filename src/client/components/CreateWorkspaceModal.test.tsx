import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import CreateWorkspaceModal from './CreateWorkspaceModal'
import { isDesktop, openDirectoryDialog } from '../lib/desktop-api'

vi.mock('../lib/desktop-api')

const mockIsDesktop = vi.mocked(isDesktop)
const mockOpenDirectoryDialog = vi.mocked(openDirectoryDialog)

const workspaceStore = {
  createWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (store: typeof workspaceStore) => unknown) => selector(workspaceStore),
}))

function renderModal(onCreated = vi.fn()) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CreateWorkspaceModal onClose={vi.fn()} onCreated={onCreated} />
    </I18nextProvider>,
  )
}

describe('CreateWorkspaceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsDesktop.mockReturnValue(false)
    mockOpenDirectoryDialog.mockResolvedValue(null)
  })

  it('leaves the app header uncovered', () => {
    const { container } = renderModal()

    expect(container.querySelector('.fixed.z-50')).toHaveClass('top-11', 'bottom-0')
  })

  it('shows the degraded hint instead of a picker when the bridge is absent', () => {
    renderModal()

    fireEvent.click(screen.getByText('Browse'))

    expect(
      screen.getByText('Folder browsing is only available in the desktop app. Enter the path manually.'),
    ).toBeInTheDocument()
    expect(mockOpenDirectoryDialog).not.toHaveBeenCalled()
  })

  it('fills folder path and name from the bridge directory dialog', async () => {
    mockIsDesktop.mockReturnValue(true)
    mockOpenDirectoryDialog.mockResolvedValue('/home/user/my-project')

    renderModal()
    fireEvent.click(screen.getByText('Browse'))

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('/home/user/my-project')
    })
    expect(screen.getByPlaceholderText('e.g. My Project')).toHaveValue('my-project')
  })

  it('reports the created workspace to its caller', async () => {
    const workspace = { id: 'ws-created', name: 'Created', folderPath: '/created' }
    const onCreated = vi.fn()
    workspaceStore.createWorkspace.mockResolvedValue(workspace)
    renderModal(onCreated)

    fireEvent.change(screen.getByPlaceholderText('e.g. My Project'), { target: { value: 'Created' } })
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), { target: { value: '/created' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(workspace))
    expect(workspaceStore.openWorkspace).toHaveBeenCalledWith('ws-created')
  })
})
