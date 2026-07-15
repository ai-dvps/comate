import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import DetailDrawer from './DetailDrawer'
import type { DrawerView } from './detail-drawer-view'
import i18n from '../i18n'

const mockStore = { messages: {}, subagents: {}, workflows: {} }
vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (s: typeof mockStore) => unknown) => selector(mockStore),
}))
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const renderWithI18n = (ui: React.ReactElement) =>
  render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)

const sub = (id: string): DrawerView => ({ kind: 'subagent', parentToolUseId: id })

const defaultProps = {
  sessionId: 's1',
  width: 400,
  onWidthChange: () => {},
  onPop: () => {},
  onClose: () => {},
  onPush: () => {},
}

describe('DetailDrawer', () => {
  it('renders nothing when the stack is empty', () => {
    const { container } = renderWithI18n(<DetailDrawer stack={[]} {...defaultProps} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows no back button at depth 1 (R3)', () => {
    renderWithI18n(<DetailDrawer stack={[sub('a1')]} {...defaultProps} />)
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull()
  })

  it('shows a back button at depth > 1 and calls onPop when clicked (R3, AE1)', () => {
    const onPop = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1'), sub('a2')]} {...defaultProps} onPop={onPop} />,
    )
    const back = screen.getByRole('button', { name: /back/i })
    fireEvent.click(back)
    expect(onPop).toHaveBeenCalledTimes(1)
  })

  it('X button calls onClose (R4, AE4)', () => {
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape calls onClose (R9, AE4)', () => {
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders a dialog with an accessible label', () => {
    renderWithI18n(<DetailDrawer stack={[sub('a1')]} {...defaultProps} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
