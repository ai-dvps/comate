import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'

import i18n from '../i18n'
import type { PromptImageDraft } from '../lib/image-input'
import PromptImageRail from './PromptImageRail'

const images: PromptImageDraft[] = [
  {
    id: 'one',
    name: 'one.png',
    mediaType: 'image/png',
    data: 'AA==',
    width: 100,
    height: 50,
    blob: new Blob(),
    previewUrl: 'blob:one',
  },
  {
    id: 'two',
    name: 'two.png',
    mediaType: 'image/png',
    data: 'AA==',
    width: 80,
    height: 80,
    blob: new Blob(),
    previewUrl: 'blob:two',
  },
]

function renderRail(overrides: Partial<React.ComponentProps<typeof PromptImageRail>> = {}) {
  const props = {
    images,
    busy: false,
    error: null,
    disabled: false,
    onRemove: vi.fn(),
    onMove: vi.fn(),
    ...overrides,
  }
  render(
    <I18nextProvider i18n={i18n}>
      <PromptImageRail {...props} />
    </I18nextProvider>,
  )
  return props
}

describe('PromptImageRail', () => {
  it('renders an ordered horizontal no-wrap rail', () => {
    renderRail()
    const rail = screen.getByTestId('prompt-image-rail')
    expect(rail).toHaveClass('overflow-x-auto', 'flex-nowrap')
    expect(screen.getAllByRole('button', { name: /Preview/ }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Preview one.png', 'Preview two.png'])
  })

  it('opens an accessible preview and returns focus to the thumbnail after closing', async () => {
    renderRail()
    const thumbnail = screen.getByRole('button', { name: 'Preview one.png' })
    thumbnail.focus()
    fireEvent.click(thumbnail)

    expect(screen.getByRole('dialog', { name: 'one.png' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await expect.poll(() => document.activeElement).toBe(thumbnail)
  })

  it('supports remove and keyboard move controls', () => {
    const props = renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Remove one.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move two.png left' }))

    expect(props.onRemove).toHaveBeenCalledWith('one')
    expect(props.onMove).toHaveBeenCalledWith(1, 0)
    expect(screen.getByRole('button', { name: 'Move one.png left' })).toBeDisabled()
  })

  it('supports pointer drag reordering and exposes busy/error state', () => {
    const props = renderRail({ busy: true, error: 'Image is too large' })
    const first = screen.getByTestId('prompt-image-one')
    const second = screen.getByTestId('prompt-image-two')
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => '0'),
      effectAllowed: 'move',
    }

    fireEvent.dragStart(first, { dataTransfer })
    fireEvent.dragOver(second, { dataTransfer })
    fireEvent.drop(second, { dataTransfer })

    expect(props.onMove).toHaveBeenCalledWith(0, 1)
    expect(screen.getByRole('status')).toHaveTextContent('Processing images')
    expect(screen.getByRole('alert')).toHaveTextContent('Image is too large')
  })
})
