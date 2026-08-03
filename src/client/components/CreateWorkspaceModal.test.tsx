import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import CreateWorkspaceModal from './CreateWorkspaceModal'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const workspaceStore = {
  createWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (store: typeof workspaceStore) => unknown) => selector(workspaceStore),
}))

describe('CreateWorkspaceModal', () => {
  it('leaves the app header uncovered', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <CreateWorkspaceModal onClose={vi.fn()} />
      </I18nextProvider>,
    )

    expect(container.querySelector('.fixed.z-50')).toHaveClass('top-11', 'bottom-0')
  })
})
