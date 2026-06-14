import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PromptGhostText from './PromptGhostText'

describe('PromptGhostText', () => {
  it('renders nothing when neither hint nor completion is provided', () => {
    render(
      <PromptGhostText
        input=""
        argumentHint={null}
        lastInsertedCommand={null}
        completionSuggestion={null}
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
        completionSuggestion="the changes"
      />,
    )
    expect(screen.getByText('<message>')).toBeInTheDocument()
    expect(screen.queryByText('the changes')).not.toBeInTheDocument()
  })

  it('shows the completion suggestion when no argument hint is active', () => {
    render(
      <PromptGhostText
        input="explain "
        argumentHint={null}
        lastInsertedCommand={null}
        completionSuggestion="the function"
      />,
    )
    expect(screen.getByText('the function')).toBeInTheDocument()
  })
})
