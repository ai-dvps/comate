import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import TokenSettlement from './TokenSettlement'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('TokenSettlement', () => {
  it('shows an exact total and exposes all available breakdown fields', async () => {
    render(<TokenSettlement usage={{ quality: 'exact', totalTokens: 19,
      inputTokens: 10, outputTokens: 4, cacheReadTokens: 3,
      cacheWriteTokens: 2, thinkingTokens: 1 }} />)

    const trigger = screen.getByRole('button', { name: /tokenUsage.turn.*19/i })
    await userEvent.click(trigger)
    expect(screen.getByText('tokenUsage.input')).toBeInTheDocument()
    expect(screen.getByText('tokenUsage.cacheRead')).toBeInTheDocument()
    expect(screen.getByText('tokenUsage.thinking')).toBeInTheDocument()
  })

  it('marks estimates visibly and renders unavailable without a fake zero', () => {
    const { rerender } = render(<TokenSettlement usage={{ quality: 'estimated', totalTokens: 1200 }} />)
    expect(screen.getByText(/tokenUsage.approx/)).toBeInTheDocument()
    rerender(<TokenSettlement usage={{ quality: 'unavailable' }} />)
    expect(screen.getByText(/tokenUsage.unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/0 tokens/)).not.toBeInTheDocument()
  })
})
