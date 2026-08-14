import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import CustomTitlebar from './CustomTitlebar'

function renderTitlebar(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('CustomTitlebar', () => {
  it('aligns conversation identity and typed tabs with interactive no-drag controls', () => {
    const onToggleLeft = vi.fn()
    const onToggleRight = vi.fn()
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        workspaceName="Comate"
        sessionName="Agent shell"
        tabs={[{
          type: 'file',
          id: 'file:App.tsx',
          workspaceId: 'ws-1',
          path: 'App.tsx',
          name: 'App.tsx',
          content: '',
          isBinary: false,
          preview: false,
        }]}
        activeTabId="file:App.tsx"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onToggleLeft={onToggleLeft}
        onToggleRight={onToggleRight}
      />,
    )

    expect(screen.getByTestId('titlebar-command-center')).toHaveStyle({ width: '288px' })
    expect(screen.getByTestId('titlebar-context')).toHaveStyle({ width: '520px' })
    expect(screen.getByText('Comate')).toBeInTheDocument()
    expect(screen.getByText('Agent shell')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /App\.tsx/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByTestId('titlebar-interactive').length).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse command center' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse context panel' }))
    expect(onToggleLeft).toHaveBeenCalledOnce()
    expect(onToggleRight).toHaveBeenCalledOnce()
  })

  it('shows management identity and hides typed tabs', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        managementTitle="Settings"
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
      />,
    )

    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('moves focus to the visible expand control when a region collapses', () => {
    const leftRegion = document.createElement('div')
    leftRegion.id = 'agent-command-center-region'
    const focusedButton = document.createElement('button')
    leftRegion.appendChild(focusedButton)
    document.body.appendChild(leftRegion)
    focusedButton.focus()

    const props = {
      leftWidth: 288,
      rightWidth: 520,
      leftCollapsed: false,
      rightCollapsed: false,
      tabs: [],
      activeTabId: null,
      onSelectTab: vi.fn(),
      onCloseTab: vi.fn(),
      onAddTab: vi.fn(),
      onToggleLeft: vi.fn(),
      onToggleRight: vi.fn(),
    }
    const { rerender } = renderTitlebar(<CustomTitlebar {...props} />)
    rerender(<I18nextProvider i18n={i18n}><CustomTitlebar {...props} leftCollapsed /></I18nextProvider>)

    expect(screen.getByRole('button', { name: 'Expand command center' })).toHaveFocus()
    leftRegion.remove()
  })
})
