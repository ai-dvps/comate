import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import FilePicker, { type FilePickerHandle } from './FilePicker'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const filesMock = vi.hoisted(() => ({
  results: [] as { path: string }[],
  loading: false,
  error: undefined as string | undefined,
  truncated: false,
  search: vi.fn(),
  clear: vi.fn(),
}))

vi.mock('../stores/files-store', () => ({
  useFiles: () => filesMock,
}))

describe('FilePicker', () => {
  beforeEach(() => {
    cleanup()
    filesMock.results = []
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  function renderPicker(props: Partial<React.ComponentProps<typeof FilePicker>> = {}) {
    const handleSelect = vi.fn()
    const handleOpenChange = vi.fn()
    const ref = React.createRef<FilePickerHandle>()

    renderWithI18n(
      <FilePicker
        ref={ref}
        workspaceId="ws-1"
        open={true}
        onOpenChange={handleOpenChange}
        onSelect={handleSelect}
        anchor={<button type="button">Files</button>}
        initialFilter=""
        {...props}
      />,
    )

    return { handleSelect, handleOpenChange, ref }
  }

  it('applies contentWidth to the popover', () => {
    renderPicker({ contentWidth: 480 })
    const input = screen.getByPlaceholderText(/Search files/i)
    const popover = input.parentElement

    expect(popover).toHaveClass('w-full')
    expect(popover).not.toHaveClass('w-[360px]')
    expect(popover).toHaveStyle({ width: '480px', boxSizing: 'border-box' })
  })

  it('falls back to fixed width when contentWidth is omitted', () => {
    renderPicker()
    const input = screen.getByPlaceholderText(/Search files/i)
    const popover = input.parentElement

    expect(popover).toHaveClass('w-[360px]')
    expect(popover).not.toHaveClass('w-full')
    expect(popover).not.toHaveStyle({ width: '480px' })
  })
})
