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
})
