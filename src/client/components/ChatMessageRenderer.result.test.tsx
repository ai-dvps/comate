import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import ChatMessageRenderer from './ChatMessageRenderer'
import type { RenderableMessage, RenderablePart } from './chat-message-adapter'
import i18n from '../i18n'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const think = (t = 'hmm'): RenderablePart => ({ type: 'thinking', text: t, isStreaming: false })
const tool = (name: string, id = name): RenderablePart => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: name,
  input: {},
  isStreaming: false,
})
const text = (t: string): RenderablePart => ({ type: 'text', text: t })

function assistantMessage(parts: RenderablePart[], id = 'm1'): RenderableMessage {
  return { id, role: 'assistant', timestamp: 1, parts }
}

const GHOST_NAME = /Process region/

describe('ChatMessageRenderer result-focused mode', () => {
  it('renders process regions as ghosts and keeps text visible (R5/R6/R8)', () => {
    const msg = assistantMessage([
      think(),
      tool('Bash'),
      text('mid text'),
      think(),
      tool('Edit'),
      text('final answer'),
    ])
    renderWithI18n(
      <ChatMessageRenderer
        message={msg}
        resultMap={new Map()}
        onOpenDrawer={() => {}}
        sessionId="s1"
        displayMode="result"
      />,
    )
    const ghosts = screen.getAllByRole('button', { name: GHOST_NAME })
    expect(ghosts).toHaveLength(2)
    expect(ghosts[0].getAttribute('aria-label')).toMatch(/2 steps/)
    expect(ghosts[0].getAttribute('aria-label')).toMatch(/Bash/)
    expect(screen.getByText('mid text')).toBeInTheDocument()
    expect(screen.getByText('final answer')).toBeInTheDocument()
  })

  it('activating a ghost opens the per-region drawer (R11)', () => {
    const msg = assistantMessage([think(), tool('Bash'), text('done')])
    const onOpen = vi.fn()
    renderWithI18n(
      <ChatMessageRenderer
        message={msg}
        resultMap={new Map()}
        onOpenDrawer={() => {}}
        sessionId="s1"
        displayMode="result"
        onOpenProcessRegion={onOpen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: GHOST_NAME }))
    expect(onOpen).toHaveBeenCalledWith('m1', 0)
  })

  it('flags a ghost when a tool in its region errored (R8 error indicator)', () => {
    const msg = assistantMessage([tool('Bash'), text('done')])
    const resultMap = new Map([
      ['Bash', { type: 'tool_result', toolUseId: 'Bash', output: 'boom', isError: true }],
    ])
    renderWithI18n(
      <ChatMessageRenderer
        message={msg}
        resultMap={resultMap}
        onOpenDrawer={() => {}}
        sessionId="s1"
        displayMode="result"
      />,
    )
    expect(screen.getByRole('button', { name: GHOST_NAME })).toHaveAttribute('data-error', 'true')
  })

  it('linear mode renders parts inline with no ghosts (R1/R4 regression)', () => {
    const msg = assistantMessage([think(), tool('Bash'), text('done')])
    renderWithI18n(
      <ChatMessageRenderer
        message={msg}
        resultMap={new Map()}
        onOpenDrawer={() => {}}
        sessionId="s1"
        displayMode="linear"
      />,
    )
    expect(screen.queryByRole('button', { name: GHOST_NAME })).toBeNull()
    expect(screen.getByText('done')).toBeInTheDocument()
  })
})
