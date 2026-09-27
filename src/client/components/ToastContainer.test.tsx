import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import ToastContainer from './ToastContainer'
import { useToastStore } from '../stores/toast-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('ToastContainer', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
  })

  it('keeps a polite live region mounted even before any toast arrives', () => {
    const { container } = render(<ToastContainer />)

    // The region must predate its content: a live region inserted together
    // with its first message is not reliably announced by screen readers.
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  })

  it('announces toast messages through the polite live region without moving focus', () => {
    useToastStore.getState().addToast({ severity: 'error', message: 'Failed to open a.ts' })
    const activeBefore = document.activeElement

    render(<ToastContainer />)

    const message = screen.getByText('Failed to open a.ts')
    expect(message.closest('[aria-live="polite"]')).not.toBeNull()
    expect(document.activeElement).toBe(activeBefore)
  })
})
