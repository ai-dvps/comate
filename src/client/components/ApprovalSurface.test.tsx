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

describe('ApprovalSurface browser submit manifest (U4)', () => {
  function makeSubmitApproval(input: unknown) {
    return {
      requestId: 'req-submit-1',
      toolName: 'mcp__comate-browser__submit',
      toolUseId: 'tu-submit-1',
      input,
      inputSummary: '',
      title: 'Submit form "login" to https://example.com',
    }
  }

  const payload = {
    kind: 'browser_submit',
    pageUrl: 'https://example.com/login',
    formName: 'login',
    action: 'https://example.com/auth',
    actionOrigin: 'https://example.com',
    method: 'POST',
    fields: [
      { name: 'username', type: 'text', sensitive: false, value: 'alice' },
      { name: 'password', type: 'password', sensitive: true },
    ],
  }

  it('renders destination, method, and the field list upfront', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={makeSubmitApproval(payload)} />)
    expect(screen.getByText('https://example.com/auth')).toBeInTheDocument()
    expect(screen.getByText('POST')).toBeInTheDocument()
    expect(screen.getByText('username')).toBeInTheDocument()
    // Field name and field type both render for the password row.
    expect(screen.getAllByText('password').length).toBeGreaterThanOrEqual(1)
    // Non-sensitive values are shown; the mocked t() echoes the sensitive-marker key.
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('approval.browserSubmit.sensitiveValue')).toBeInTheDocument()
  })

  it('never renders a sensitive field value (the payload carries none by construction)', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={makeSubmitApproval(payload)} />)
    expect(screen.queryByText(/s3cret|hunter2/i)).not.toBeInTheDocument()
  })

  it('renders the reconfirmation banner and differences for a TOCTOU re-ask', () => {
    const reconfirm = {
      ...payload,
      reconfirmation: true,
      differences: [{ kind: 'action_changed' }, { kind: 'value_changed', field: 'username' }],
    }
    render(<ApprovalSurface {...baseProps} pendingItem={makeSubmitApproval(reconfirm)} />)
    expect(screen.getByText('approval.browserSubmit.reconfirmation')).toBeInTheDocument()
    expect(screen.getByText('approval.browserSubmit.diff.action_changed')).toBeInTheDocument()
    expect(screen.getByText('approval.browserSubmit.diff.value_changed')).toBeInTheDocument()
  })

  it('falls back to the structured view for non-submit inputs', () => {
    render(
      <ApprovalSurface
        {...baseProps}
        pendingItem={makeSubmitApproval({ ref: 'e3-aa', fields: { user: 'alice' } })}
      />,
    )
    expect(screen.queryByText('approval.browserSubmit.destination')).not.toBeInTheDocument()
  })
})
