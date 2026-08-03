import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import HeaderToolbar from './HeaderToolbar'

vi.mock('../hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}))

function renderToolbar(popupOpen = false) {
  return render(
    <I18nextProvider i18n={i18n}>
      <HeaderToolbar
        popupOpen={popupOpen}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    </I18nextProvider>,
  )
}

describe('HeaderToolbar', () => {
  it('disables each popup trigger while another popup is open', () => {
    renderToolbar(true)

    expect(screen.getByTitle('Create workspace')).toBeDisabled()
    expect(screen.getByTitle('Todos')).toBeDisabled()
    expect(screen.getByTitle('Analytics')).toBeDisabled()
    expect(screen.getByTitle('Settings')).toBeDisabled()
  })

  it('keeps popup triggers enabled when no popup is open', () => {
    renderToolbar()

    expect(screen.getByTitle('Create workspace')).toBeEnabled()
    expect(screen.getByTitle('Todos')).toBeEnabled()
    expect(screen.getByTitle('Analytics')).toBeEnabled()
    expect(screen.getByTitle('Settings')).toBeEnabled()
  })
})
