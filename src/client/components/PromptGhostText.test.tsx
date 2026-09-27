import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PromptGhostText from './PromptGhostText'

describe('PromptGhostText', () => {
  it('renders nothing when no argument hint is provided', () => {
    render(
      <PromptGhostText
        input=""
        argumentHint={null}
        lastInsertedCommand={null}
      />,
    )
    expect(screen.queryByText(/hint/i)).not.toBeInTheDocument()
  })

  it('shows the argument hint when input matches the last inserted command', () => {
    render(
      <PromptGhostText
        input="/commit "
        argumentHint="<message>"
        lastInsertedCommand="/commit "
      />,
    )
    expect(screen.getByText('<message>')).toBeInTheDocument()
  })
})
