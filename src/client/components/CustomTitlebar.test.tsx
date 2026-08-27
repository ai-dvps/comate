import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import CustomTitlebar from './CustomTitlebar'

function renderTitlebar(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('CustomTitlebar', () => {
  it('renders every titlebar icon with a softer color and thinner stroke', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={0}
        rightWidth={520}
        leftCollapsed
        rightCollapsed={false}
        contextAvailable
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
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
      />,
    )

    const icons = screen.getByTestId('custom-titlebar').querySelectorAll('svg')
    expect(icons.length).toBeGreaterThan(0)
    icons.forEach((icon) => {
      expect(icon).toHaveAttribute('stroke-width', '1.5')
      expect(icon).toHaveClass('text-text-tertiary/70')
    })
  })

  it('aligns conversation identity and typed tabs with interactive no-drag controls', () => {
    const onToggleLeft = vi.fn()
    const onToggleRight = vi.fn()
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        contextAvailable
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
        onNewChat={vi.fn()}
        onToggleLeft={onToggleLeft}
        onToggleRight={onToggleRight}
      />,
    )

    expect(screen.getByTestId('custom-titlebar')).not.toHaveClass('border-b')
    expect(screen.getByTestId('titlebar-command-center')).toHaveStyle({ width: '288px' })
    expect(screen.getByTestId('titlebar-command-center')).toHaveClass('border-r')
    expect(screen.getByTestId('titlebar-command-center')).toHaveClass('border-b')
    expect(screen.getByTestId('titlebar-conversation')).toHaveClass('border-b')
    expect(screen.getByTestId('titlebar-context')).toHaveClass('border-b')
    expect(screen.getByTestId('titlebar-context')).toHaveAttribute('data-electron-drag-region')
    expect(screen.getByTestId('titlebar-context')).toHaveStyle({ width: '520px' })
    expect(screen.getByText('Comate')).toBeInTheDocument()
    expect(screen.getByText('Agent shell')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /App\.tsx/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /App\.tsx/ })).toHaveAttribute('data-testid', 'titlebar-interactive')
    expect(screen.getByRole('tablist')).not.toHaveAttribute('data-testid', 'titlebar-interactive')
    expect(screen.getAllByTestId('titlebar-interactive').length).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse command center' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse context panel' }))
    expect(onToggleLeft).toHaveBeenCalledOnce()
    expect(onToggleRight).toHaveBeenCalledOnce()
  })

  it('distinguishes preview tabs with italic names and a pin hint', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        contextAvailable
        tabs={[
          {
            type: 'file',
            id: 'file:preview',
            workspaceId: 'ws-1',
            path: 'Preview.tsx',
            name: 'Preview.tsx',
            content: '',
            isBinary: false,
            preview: true,
          },
          {
            type: 'file',
            id: 'file:App.tsx',
            workspaceId: 'ws-1',
            path: 'App.tsx',
            name: 'App.tsx',
            content: '',
            isBinary: false,
            preview: false,
          },
        ]}
        activeTabId="file:preview"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
      />,
    )

    const previewTab = screen.getByRole('tab', { name: /Preview\.tsx/ })
    expect(previewTab.querySelector('span')).toHaveClass('italic')
    expect(previewTab).toHaveAttribute(
      'title',
      'Preview tab — double-click a file in the tree to keep it open',
    )

    const durableTab = screen.getByRole('tab', { name: /App\.tsx/ })
    expect(durableTab.querySelector('span')).not.toHaveClass('italic')
    expect(durableTab).not.toHaveAttribute('title')
  })

  it('shows management identity and hides typed tabs', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        contextAvailable
        managementTitle="Settings"
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
      />,
    )

    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('shows a new chat shortcut beside the collapsed left toggle', () => {
    const onNewChat = vi.fn()
    renderTitlebar(
      <CustomTitlebar
        leftWidth={0}
        rightWidth={520}
        leftCollapsed
        rightCollapsed={false}
        contextAvailable
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={onNewChat}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))

    expect(onNewChat).toHaveBeenCalledOnce()
    expect(screen.getByTestId('titlebar-command-center')).toHaveStyle({ width: '88px' })
  })

  it('hides the new chat shortcut while the left panel is expanded', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        contextAvailable
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
  })

  it('keeps the macOS left controls clear of the traffic lights when collapsed', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={0}
        rightWidth={520}
        leftCollapsed
        rightCollapsed={false}
        contextAvailable
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
        isMac
      />,
    )

    expect(screen.getByTestId('titlebar-command-center')).toHaveStyle({ width: '152px' })
    expect(screen.getByTestId('titlebar-command-center')).toHaveClass('border-b')
    expect(screen.getByTestId('titlebar-command-center')).not.toHaveClass('border-r')
    expect(screen.getByTestId('titlebar-macos-traffic-lights')).toHaveClass('flex-shrink-0')
  })

  it('removes the right divider while the context panel is collapsed', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={0}
        leftCollapsed={false}
        rightCollapsed
        contextAvailable
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
      />,
    )

    expect(screen.getByTestId('titlebar-context')).not.toHaveClass('border-l')
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
      contextAvailable: true,
      tabs: [],
      activeTabId: null,
      onSelectTab: vi.fn(),
      onCloseTab: vi.fn(),
      onAddTab: vi.fn(),
      onNewChat: vi.fn(),
      onToggleLeft: vi.fn(),
      onToggleRight: vi.fn(),
    }
    const { rerender } = renderTitlebar(<CustomTitlebar {...props} />)
    rerender(<I18nextProvider i18n={i18n}><CustomTitlebar {...props} leftCollapsed /></I18nextProvider>)

    expect(screen.getByRole('button', { name: 'Expand command center' })).toHaveFocus()
    leftRegion.remove()
  })

  it('removes context controls and their layout space when no workspace is open', () => {
    const onToggleRight = vi.fn()
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        contextAvailable={false}
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={onToggleRight}
      />,
    )

    expect(screen.getByTestId('titlebar-context')).toHaveStyle({ width: '0px' })
    expect(screen.queryByRole('button', { name: 'Collapse context panel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Expand context panel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add context tab' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(onToggleRight).not.toHaveBeenCalled()
  })

  it('preserves only the Windows window-control clearance on the Welcome screen', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={520}
        leftCollapsed={false}
        rightCollapsed={false}
        contextAvailable={false}
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
        isWindows
      />,
    )

    expect(screen.getByTestId('titlebar-context')).toHaveStyle({ width: '138px' })
  })

  it('keeps Windows window controls beside the expanded context segment', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={288}
        rightWidth={320}
        leftCollapsed={false}
        rightCollapsed={false}
        contextAvailable
        viewportWidth={1000}
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
        isWindows
      />,
    )

    expect(screen.getByTestId('titlebar-context')).toHaveStyle({ width: '458px' })
  })

  it('hides the conversation identity when an expanded context leaves too little space', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={0}
        rightWidth={320}
        leftCollapsed
        rightCollapsed={false}
        contextAvailable
        viewportWidth={480}
        workspaceName="Comate"
        sessionName="Narrow session"
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
        isMac
      />,
    )

    expect(screen.getByTestId('titlebar-context')).toHaveStyle({ width: '320px' })
    expect(screen.getByTestId('titlebar-conversation')).not.toHaveClass('px-3')
    expect(screen.queryByText('Comate')).not.toBeInTheDocument()
    expect(screen.queryByText('Narrow session')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse context panel' })).toBeVisible()
  })

  it('keeps the conversation identity and spacing when enough width remains', () => {
    renderTitlebar(
      <CustomTitlebar
        leftWidth={0}
        rightWidth={320}
        leftCollapsed
        rightCollapsed={false}
        contextAvailable
        viewportWidth={800}
        workspaceName="Comate"
        sessionName="Wide session"
        tabs={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={vi.fn()}
        onNewChat={vi.fn()}
        onToggleLeft={vi.fn()}
        onToggleRight={vi.fn()}
        isMac
      />,
    )

    expect(screen.getByTestId('titlebar-conversation')).toHaveClass('px-3')
    expect(screen.getByText('Comate')).toBeVisible()
    expect(screen.getByText('Wide session')).toBeVisible()
  })
})
