import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import BackgroundTaskList from './BackgroundTaskList'
import type { SessionBackgroundTask } from '../types/message'

function renderList(tasks: SessionBackgroundTask[], supportsStop = true) {
  const onStop = vi.fn()
  render(<I18nextProvider i18n={i18n}><BackgroundTaskList tasks={tasks} supportsStop={supportsStop}
    isStopping={() => false} onStop={onStop} typeLabel={() => 'Agent'} /></I18nextProvider>)
  return onStop
}

describe('BackgroundTaskList', () => {
  it('orders children after their parent and preserves the selected run on stop', () => {
    const child = { id: 'child', parentTaskId: 'parent', runId: 'b', subagentType: 'researcher', type: 'agent', description: 'Research' }
    const onStop = renderList([child, { id: 'parent', type: 'agent', description: 'Coordinate' }])
    expect(screen.getByText('Coordinate').compareDocumentPosition(screen.getByText('Research')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.getByText('researcher')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop task: Research' }))
    expect(onStop).toHaveBeenCalledWith(child)
  })

  it('keeps cyclic and orphaned tasks visible without recursive rendering', () => {
    renderList([
      { id: 'one', parentTaskId: 'two', type: 'agent', description: 'One' },
      { id: 'two', parentTaskId: 'one', type: 'agent', description: 'Two' },
      { id: 'three', parentTaskId: 'missing', type: 'agent', description: 'Three' },
    ], false)
    for (const name of ['One', 'Two', 'Three']) expect(screen.getByText(name)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps maintenance tasks in a collapsed disclosure with explicit stop controls', () => {
    renderList([{ id: 'watcher', type: 'monitor', description: 'Watch updates', ambient: true }])
    const summary = screen.getByText('Maintenance tasks (1)')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(summary)
    expect(screen.getByRole('button', { name: 'Stop task: Watch updates' })).toBeInTheDocument()
  })
})
