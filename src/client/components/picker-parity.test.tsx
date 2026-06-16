import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import CommandPicker, { type CommandPickerHandle } from './CommandPicker'
import FilePicker, { type FilePickerHandle } from './FilePicker'
import HistoryPicker, { type HistoryPickerHandle } from './HistoryPicker'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('picker handle parity', () => {
  it('CommandPickerHandle, FilePickerHandle, and HistoryPickerHandle all expose the same imperative API', () => {
    const commandRef = React.createRef<CommandPickerHandle>()
    const fileRef = React.createRef<FilePickerHandle>()
    const historyRef = React.createRef<HistoryPickerHandle>()

    renderWithI18n(
      <>
        <CommandPicker
          ref={commandRef}
          workspaceId="ws-1"
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
          anchor={<button type="button">Commands</button>}
        />
        <FilePicker
          ref={fileRef}
          workspaceId="ws-1"
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
          anchor={<button type="button">Files</button>}
        />
        <HistoryPicker
          ref={historyRef}
          workspaceId="ws-1"
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
          anchor={<button type="button">History</button>}
        />
      </>,
    )

    // The refs are typed to their components; the test verifies at compile
    // time that the three handle shapes share { moveDown, moveUp, commitActive }.
    // Runtime assertions guard against future drift in the type definitions.
    expect(typeof commandRef.current?.moveDown).toBe('function')
    expect(typeof commandRef.current?.moveUp).toBe('function')
    expect(typeof commandRef.current?.commitActive).toBe('function')

    expect(typeof fileRef.current?.moveDown).toBe('function')
    expect(typeof fileRef.current?.moveUp).toBe('function')
    expect(typeof fileRef.current?.commitActive).toBe('function')

    expect(typeof historyRef.current?.moveDown).toBe('function')
    expect(typeof historyRef.current?.moveUp).toBe('function')
    expect(typeof historyRef.current?.commitActive).toBe('function')
  })
})
