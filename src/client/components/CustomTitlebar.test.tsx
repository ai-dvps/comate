import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import CustomTitlebar from './CustomTitlebar'

describe('CustomTitlebar', () => {
  it('aligns conversation identity and typed tabs with interactive no-drag controls', () => {
    const onToggleLeft = vi.fn()
    const onToggleRight = vi.fn()
    render(
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
    render(
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
})
