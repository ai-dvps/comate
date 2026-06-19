import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import ApprovalSurface from './ApprovalSurface'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, string>) => {
    if (key === 'approval.denialReason_safetyCheck') return 'This request was flagged by a safety check.'
    if (key === 'approval.denialReason_asyncAgent') return 'This request was denied because it originated from an async agent.'
    if (key === 'approval.denialReason_default') return `This request was denied: ${params?.reason ?? ''}`
    if (key === 'approval.denialReason') return 'Denial reason'
    if (key === 'approval.allow') return 'Allow'
    if (key === 'approval.deny') return 'Deny'
    if (key === 'approval.stop') return 'Stop'
    return key
  } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const noop = () => {}

function makePendingApproval(denialReason?: string) {
  return {
    requestId: 'req-1',
    toolName: 'Bash',
    toolUseId: 'tu-1',
    input: { command: 'rm -rf /' },
    inputSummary: '',
    title: 'Dangerous command',
    description: 'This will delete everything',
    denialReason,
  }
}

const baseProps = {
  workspaceId: 'ws-1',
  pendingItem: makePendingApproval(),
  queueDepth: 0,
  isResolving: false,
  onAllow: noop,
  onAllowAlways: noop,
  onDeny: noop,
  onAnswerQuestion: noop,
  onChatAbout: noop,
  onStop: noop,
}

describe('ApprovalSurface denial reason', () => {
  it('renders safetyCheck denial reason notice', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={makePendingApproval('safetyCheck')} />)
    expect(screen.getByText('This request was flagged by a safety check.')).toBeInTheDocument()
  })

  it('renders asyncAgent denial reason notice', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={makePendingApproval('asyncAgent')} />)
    expect(screen.getByText('This request was denied because it originated from an async agent.')).toBeInTheDocument()
  })

  it('renders fallback denial reason notice for unknown reasons', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={makePendingApproval('customReason')} />)
    expect(screen.getByText('This request was denied: customReason')).toBeInTheDocument()
  })

  it('does not render denial reason notice when absent', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={makePendingApproval()} />)
    expect(screen.queryByText('Denial reason')).not.toBeInTheDocument()
  })
})
