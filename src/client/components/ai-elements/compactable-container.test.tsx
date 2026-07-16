import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CompactableContainer } from './compactable-container'

describe('CompactableContainer', () => {
  it('always expanded renders children fully and hides the toggle', () => {
    render(
      <CompactableContainer alwaysExpanded data-testid="container">
        <div>always visible content</div>
      </CompactableContainer>,
    )

    expect(screen.getByText('always visible content')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Show details')).not.toBeInTheDocument()
    expect(screen.queryByText('Hide details')).not.toBeInTheDocument()
  })

  it('keeps the toggle in default mode and toggles aria-expanded', async () => {
    render(
      <CompactableContainer alwaysShowToggle data-testid="container">
        <div>toggleable content</div>
      </CompactableContainer>,
    )

    const toggle = screen.getByRole('button')
    expect(toggle).toHaveTextContent('Show details')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)

    expect(toggle).toHaveTextContent('Hide details')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('applies search-match ring classes when matched', () => {
    const { container } = render(
      <CompactableContainer hasSearchMatch isCurrentSearchMatch>
        matched
      </CompactableContainer>,
    )

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('ring-1')
    expect(wrapper).toHaveClass('ring-accent')
    expect(wrapper).toHaveClass('bg-accent/5')
  })
})
