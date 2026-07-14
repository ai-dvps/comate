import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import SessionListItem from './SessionListItem'
import i18n from '../i18n'
import type { ChatSession } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const now = new Date().toISOString()
  return {
    id: 's1',
    workspaceId: 'ws1',
    name: 'Test Session',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const noop = () => {}

const baseProps = {
  displayName: 'Test Session',
  isActive: false,
  isStreaming: false,
  pendingCount: 0,
  unread: false,
  preview: '',
  editingSessionId: null,
  editingName: '',
  useModifierToSubmit: false,
  onStartEdit: noop,
  onCommitEdit: noop,
  onCancelEdit: noop,
  onSetEditingName: noop,
  onContextMenu: noop,
  onActivate: noop,
  t: i18n.getFixedT(null, 'chat'),
}

describe('SessionListItem', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders the Draft badge for draft sessions', () => {
    renderWithI18n(<SessionListItem session={makeSession({ isDraft: true })} {...baseProps} />)
    expect(screen.getByText('Draft')).toBeDefined()
  })

  it('does not render the Draft badge for non-draft sessions', () => {
    renderWithI18n(<SessionListItem session={makeSession({ isDraft: false })} {...baseProps} />)
    expect(screen.queryByText('Draft')).toBeNull()
  })

  it('does not render an approval-mode badge for auto sessions', () => {
    renderWithI18n(<SessionListItem session={makeSession({ approvalMode: 'auto' })} {...baseProps} />)
    expect(screen.queryByText('Auto')).toBeNull()
  })

  it('does not render an approval-mode badge for readonly sessions', () => {
    renderWithI18n(
      <SessionListItem session={makeSession({ approvalMode: 'readonly' })} {...baseProps} />,
    )
    expect(screen.queryByText('Readonly')).toBeNull()
  })

  describe('bot icon active/inactive distinction', () => {
    it('renders the WeCom icon at full color when active', () => {
      renderWithI18n(
        <SessionListItem session={makeSession({ source: 'wecom' })} {...baseProps} isActive />,
      )
      const img = screen.getByAltText('WeCom')
      expect(img.className).not.toContain('grayscale')
      expect(img.className).not.toContain('opacity-40')
    })

    it('renders the WeCom icon desaturated and dimmed when inactive', () => {
      renderWithI18n(
        <SessionListItem session={makeSession({ source: 'wecom' })} {...baseProps} />,
      )
      const img = screen.getByAltText('WeCom')
      expect(img.className).toContain('grayscale')
      expect(img.className).toContain('opacity-40')
    })

    it('renders the Feishu icon desaturated and dimmed when inactive', () => {
      renderWithI18n(
        <SessionListItem session={makeSession({ source: 'feishu' })} {...baseProps} />,
      )
      const img = screen.getByAltText('Feishu')
      expect(img.className).toContain('grayscale')
      expect(img.className).toContain('opacity-40')
    })

    it('renders the Feishu icon at full color when active', () => {
      renderWithI18n(
        <SessionListItem session={makeSession({ source: 'feishu' })} {...baseProps} isActive />,
      )
      const img = screen.getByAltText('Feishu')
      expect(img.className).not.toContain('grayscale')
      expect(img.className).not.toContain('opacity-40')
    })

    it('does not render any bot icon for non-bot (gui) sessions', () => {
      renderWithI18n(<SessionListItem session={makeSession({ source: 'gui' })} {...baseProps} />)
      expect(screen.queryByAltText('WeCom')).toBeNull()
      expect(screen.queryByAltText('Feishu')).toBeNull()
    })

    it('exposes aria-current on the active session row', () => {
      const { container } = renderWithI18n(
        <SessionListItem session={makeSession({ source: 'wecom' })} {...baseProps} isActive />,
      )
      const row = container.querySelector('.session-item')
      expect(row?.getAttribute('aria-current')).toBe('true')
    })

    it('does not expose aria-current on an inactive session row', () => {
      const { container } = renderWithI18n(
        <SessionListItem session={makeSession({ source: 'wecom' })} {...baseProps} />,
      )
      const row = container.querySelector('.session-item')
      expect(row?.getAttribute('aria-current')).toBeNull()
    })
  })
})
