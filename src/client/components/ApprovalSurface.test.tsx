import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
    if (key === 'approval.collapsePanel') return 'Collapse panel'
    if (key === 'approval.expandPanel') return 'Expand panel'
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
  onDecideLater: noop,
  onAnswerQuestion: noop,
  onChatAbout: noop,
  onStop: noop,
}

describe('ApprovalSurface question option highlight', () => {
  it('draws the focused option ring inside the scroll container', () => {
    render(
      <ApprovalSurface
        {...baseProps}
        pendingItem={{
          requestId: 'req-question-1',
          questions: [
            {
              question: 'Choose an option',
              options: [{ label: 'Option A' }, { label: 'Option B' }],
              multiSelect: false,
            },
          ],
        }}
      />,
    )

    expect(screen.getByRole('radio', { name: 'Option A' })).toHaveClass('ring-inset')
  })

  it('submits an answered question with Cmd/Ctrl+Enter', async () => {
    const user = userEvent.setup()
    const onAnswerQuestion = vi.fn()
    render(
      <ApprovalSurface
        {...baseProps}
        onAnswerQuestion={onAnswerQuestion}
        pendingItem={{
          requestId: 'req-question-shortcut',
          questions: [
            {
              question: 'Choose an option',
              options: [{ label: 'Option A' }, { label: 'Option B' }],
              multiSelect: false,
            },
          ],
        }}
      />,
    )

    await user.click(screen.getByRole('radio', { name: 'Option A' }))
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })

    expect(onAnswerQuestion).toHaveBeenCalledWith({ 'Choose an option': 'Option A' })
  })

  it('does not submit an unanswered question with Cmd/Ctrl+Enter', () => {
    const onAnswerQuestion = vi.fn()
    render(
      <ApprovalSurface
        {...baseProps}
        onAnswerQuestion={onAnswerQuestion}
        pendingItem={{
          requestId: 'req-question-shortcut-disabled',
          questions: [
            {
              question: 'Choose an option',
              options: [{ label: 'Option A' }],
              multiSelect: false,
            },
          ],
        }}
      />,
    )

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    expect(onAnswerQuestion).not.toHaveBeenCalled()
  })
})

describe('ApprovalSurface submit shortcut', () => {
  it.each([
    ['Cmd+Enter', { metaKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }],
  ])('allows the request with %s', (_label, modifiers) => {
    const onAllow = vi.fn()
    render(<ApprovalSurface {...baseProps} onAllow={onAllow} />)

    fireEvent.keyDown(window, { key: 'Enter', ...modifiers })

    expect(onAllow).toHaveBeenCalledOnce()
  })

  it('ignores the shortcut while the request is resolving', () => {
    const onAllow = vi.fn()
    render(<ApprovalSurface {...baseProps} onAllow={onAllow} isResolving />)

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })

    expect(onAllow).not.toHaveBeenCalled()
  })
})

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

describe('ApprovalSurface browser activation and upload manifests', () => {
  function pending(toolName: string, input: unknown) {
    return { requestId: `req-${toolName}`, toolName, toolUseId: `tu-${toolName}`, input, inputSummary: '', title: 'Security review' }
  }

  it('renders initial and reconfirmation activation security fields upfront', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={pending('mcp__comate-browser__activate', {
      kind: 'browser_activation',
      warning: 'Remote page action',
      origin: 'https://example.com',
      target: {
        role: { source: 'untrusted_page', text: 'button' },
        name: { source: 'untrusted_page', text: 'Publish article' },
        nearbyContext: { source: 'untrusted_page', text: 'Draft editor' },
      },
      editorSummary: { editorCount: 2, filledEditorCount: 2, totalEditorLength: 2048 },
      reconfirmation: true,
      differences: ['target_geometry_changed'],
    })} />)
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
    expect(screen.getByText('Publish article')).toBeInTheDocument()
    expect(screen.getByText('Draft editor')).toBeInTheDocument()
    expect(screen.getByText('target_geometry_changed')).toBeInTheDocument()
    expect(screen.queryByText('approval.showMore')).not.toBeInTheDocument()
  })

  it('renders multiple relative workspace files and totals without paths or content', () => {
    const { container } = render(<ApprovalSurface {...baseProps} pendingItem={pending('mcp__comate-browser__upload', {
      kind: 'browser_upload', warning: 'Share local media', origin: 'https://example.com',
      files: [
        { source: 'workspace_file', name: 'cover.png', mediaType: 'image/png', size: 2048 },
        { source: 'workspace_file', name: 'clip.mp4', mediaType: 'video/mp4', size: 1048576 },
      ],
      totalBytes: 1050624,
      target: { accept: { source: 'untrusted_page', text: 'image/*,video/*' }, multiple: true },
    })} />)
    expect(screen.getByText('cover.png')).toBeInTheDocument()
    expect(screen.getByText('clip.mp4')).toBeInTheDocument()
    expect(screen.getByText('image/png')).toBeInTheDocument()
    expect(container.textContent).not.toContain('/Users/')
    expect(container.textContent).not.toContain('PRIVATE_FILE_BYTES')
    expect(screen.queryByText('approval.showMore')).not.toBeInTheDocument()
  })
})

describe('ApprovalSurface browser declaration manifest', () => {
  const pending = {
    requestId: 'req-declaration', toolName: 'mcp__comate-browser__setDeclaration',
    toolUseId: 'tu-declaration', inputSummary: '', title: 'Confirm declaration',
    input: {
      kind: 'browser_declaration', origin: 'https://example.com', intendedState: true,
      declaration: { source: 'untrusted_page', text: 'This work is original' },
      taskSummary: { source: 'derived_metadata', taskVersion: 7, populatedSlots: 3, verifiedSlots: 2, mediaSlots: 1 },
    },
  }

  it('shows the trusted hierarchy and distinct single-use actions', () => {
    const onAllowAlways = vi.fn()
    const onDecideLater = vi.fn()
    render(<ApprovalSurface {...baseProps} pendingItem={pending} onAllowAlways={onAllowAlways} onDecideLater={onDecideLater} />)
    expect(screen.getByText('This work is original')).toBeInTheDocument()
    expect(screen.getByText('approval.browserDeclaration.warning')).toBeInTheDocument()
    expect(screen.queryByText('approval.allowAlways')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'approval.browserDeclaration.decideLater' }))
    expect(onDecideLater).toHaveBeenCalledOnce()
  })

  it('does not let Cmd/Ctrl+Enter confirm a declaration', () => {
    const onAllow = vi.fn()
    render(<ApprovalSurface {...baseProps} pendingItem={pending} onAllow={onAllow} />)
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(onAllow).not.toHaveBeenCalled()
  })

  it('fails closed without exposing raw fallback data when the declaration manifest is malformed', () => {
    render(<ApprovalSurface {...baseProps} pendingItem={{ ...pending, input: {
      kind: 'browser_declaration', secret: 'RAW_PRIVATE_DIGEST', declaration: 'bad',
    } }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('approval.securityManifestInvalid')
    expect(screen.queryByText('RAW_PRIVATE_DIGEST')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'approval.browserDeclaration.confirmAction' })).toBeDisabled()
  })
})

describe('ApprovalSurface collapsible panel', () => {
  it('renders expanded by default', () => {
    render(<ApprovalSurface {...baseProps} />)
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
  })

  it('toggles body visibility when collapse/expand button is clicked', async () => {
    const user = userEvent.setup()
    render(<ApprovalSurface {...baseProps} />)

    const toggle = screen.getByRole('button', { name: 'Collapse panel' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(toggle)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Expand panel' })).toHaveAttribute('aria-expanded', 'false')

    await user.click(screen.getByRole('button', { name: 'Expand panel' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('resets to expanded when pendingItem.requestId changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ApprovalSurface {...baseProps} />)

    await user.click(screen.getByRole('button', { name: 'Collapse panel' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument())

    rerender(
      <ApprovalSurface
        {...baseProps}
        pendingItem={{ ...baseProps.pendingItem, requestId: 'req-2' }}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('exposes aria-expanded and title on the toggle button', () => {
    render(<ApprovalSurface {...baseProps} />)
    const toggle = screen.getByRole('button', { name: 'Collapse panel' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('title', 'Collapse panel')
  })
})
