import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import '../index.css'

import ChatMessageRenderer, { type RenderableMessage } from './ChatMessageRenderer'
import i18n from '../i18n'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const message: RenderableMessage = {
  id: 'process-region-message',
  role: 'assistant',
  parts: [
    {
      type: 'tool_use',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      isStreaming: false,
    },
  ],
}

describe('ChatMessageRenderer browser layout', () => {
  afterEach(cleanup)

  it('fills the available width at every message layer when fullWidth is enabled', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <div data-testid="drawer-body" style={{ width: 600 }}>
          <ChatMessageRenderer
            message={message}
            resultMap={new Map()}
            onOpenDrawer={() => {}}
            sessionId="session-1"
            fullWidth
          />
        </div>
      </I18nextProvider>,
    )

    const drawerBody = screen.getByTestId('drawer-body')
    const rendererRoot = drawerBody.firstElementChild as HTMLElement
    const messageRoot = rendererRoot.firstElementChild as HTMLElement
    const messageContent = messageRoot.firstElementChild as HTMLElement
    const availableWidth = drawerBody.getBoundingClientRect().width

    expect(rendererRoot.getBoundingClientRect().width).toBeCloseTo(availableWidth, 0)
    expect(messageRoot.getBoundingClientRect().width).toBeCloseTo(availableWidth, 0)
    expect(messageContent.getBoundingClientRect().width).toBeCloseTo(availableWidth, 0)
  })
})
