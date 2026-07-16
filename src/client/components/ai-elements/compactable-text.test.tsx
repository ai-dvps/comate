import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import CompactableText from './compactable-text'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

describe('CompactableText', () => {
  it('renders full text without a toggle', () => {
    const text = 'compactable-text-long-content-'.repeat(50)
    render(<CompactableText>{text}</CompactableText>)

    expect(screen.getByText(text)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Show more')).not.toBeInTheDocument()
    expect(screen.queryByText('Show less')).not.toBeInTheDocument()
  })

  it('applies search-match ring classes when matched', () => {
    render(
      <CompactableText hasSearchMatch isCurrentSearchMatch>
        matched text
      </CompactableText>,
    )

    const container = screen.getByText('matched text').parentElement
    expect(container).toHaveClass('ring-1')
    expect(container).toHaveClass('ring-accent')
    expect(container).toHaveClass('bg-accent/5')
  })

  it('applies inactive search-match ring classes for a non-current match', () => {
    render(
      <CompactableText hasSearchMatch={false} isCurrentSearchMatch>
        text
      </CompactableText>,
    )

    const container = screen.getByText('text').parentElement
    expect(container).not.toHaveClass('ring-1')
  })
})
