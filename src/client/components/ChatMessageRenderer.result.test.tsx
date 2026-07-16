import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
const toolInput = (name: string, input: unknown, id = name): RenderablePart => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: name,
  input,
  isStreaming: false,
})
const text = (t: string): RenderablePart => ({ type: 'text', text: t })

function assistantMessage(parts: RenderablePart[], id = 'm1'): RenderableMessage {
  return { id, role: 'assistant', timestamp: 1, parts }
}

const GHOST_NAME = /Process region/

describe('ChatMessageRenderer result-focused mode', () => {
  let originalScrollHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
  })

  afterEach(() => {
    if (originalScrollHeight) {
      Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight)
    } else {
      delete (Element.prototype as { scrollHeight?: number }).scrollHeight
    }
  })
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

  it('shows the latest tool key parameter in the result-mode ghost (R1)', () => {
    const msg = assistantMessage([
      think(),
      toolInput('Bash', { command: 'npm test' }),
      text('done'),
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
    expect(ghosts).toHaveLength(1)
    expect(ghosts[0].getAttribute('aria-label')).toMatch(/Bash ▸ npm test/)
    expect(ghosts[0].textContent).toContain('npm test')
  })

  it('renders process region duration in result mode (U4)', () => {
    const msg = assistantMessage([
      { ...think(), timestamp: 1000 },
      { ...tool('Bash'), timestamp: 2000 },
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
    const ghost = screen.getByRole('button', { name: GHOST_NAME })
    expect(ghost.textContent).toMatch(/2 steps/)
    expect(ghost.textContent).toMatch(/1s/)
    expect(ghost.textContent).toMatch(/Bash/)
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
      ['Bash', { type: 'tool_result' as const, toolUseId: 'Bash', output: 'boom', isError: true }],
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

  it('linear mode renders tool cards expanded by default (R5)', () => {
    const msg = assistantMessage([toolInput('Bash', { command: 'npm test' })])
    renderWithI18n(
      <ChatMessageRenderer
        message={msg}
        resultMap={new Map()}
        onOpenDrawer={() => {}}
        sessionId="s1"
        displayMode="linear"
      />,
    )

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show details/i })).not.toBeInTheDocument()
  })

  it('linear mode collapses tool cards when defaultToolExpanded is false (R2)', () => {
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    })

    const msg = assistantMessage([toolInput('Bash', { command: 'npm test' })])
    renderWithI18n(
      <ChatMessageRenderer
        message={msg}
        resultMap={new Map()}
        onOpenDrawer={() => {}}
        sessionId="s1"
        displayMode="linear"
        defaultToolExpanded={false}
      />,
    )

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Show details/i })).toBeInTheDocument()
  })

  it('result mode ignores defaultToolExpanded and still renders ghosts (R5)', () => {
    const msg = assistantMessage([think(), tool('Bash'), text('done')])
    renderWithI18n(
      <ChatMessageRenderer
        message={msg}
        resultMap={new Map()}
        onOpenDrawer={() => {}}
        sessionId="s1"
        displayMode="result"
        defaultToolExpanded={false}
      />,
    )

    expect(screen.getByRole('button', { name: GHOST_NAME })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show details/i })).not.toBeInTheDocument()
  })
})
