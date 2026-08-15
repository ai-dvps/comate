import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import ApprovalModeToggle from './ApprovalModeToggle'

const setSessionApprovalMode = vi.fn()

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({
    sessions: { 'ws-1': [{ id: 'session-1', approvalMode: 'manual' }] },
    setSessionApprovalMode,
  }),
}))

describe('ApprovalModeToggle', () => {
  beforeEach(() => setSessionApprovalMode.mockClear())

  it('selects a permission mode locally in New Chat mode', () => {
    const onApprovalModeChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ApprovalModeToggle
          mode="new-chat"
          workspaceId="ws-1"
          approvalMode="manual"
          onApprovalModeChange={onApprovalModeChange}
        />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Manual/ }))
    fireEvent.click(screen.getByText('Auto'))

    expect(onApprovalModeChange).toHaveBeenCalledWith('auto')
    expect(setSessionApprovalMode).not.toHaveBeenCalled()
  })

  it('keeps the existing session update path unchanged', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ApprovalModeToggle workspaceId="ws-1" sessionId="session-1" />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Manual/ }))
    fireEvent.click(screen.getByText('Auto'))

    expect(setSessionApprovalMode).toHaveBeenCalledWith('ws-1', 'session-1', 'auto')
  })
})
