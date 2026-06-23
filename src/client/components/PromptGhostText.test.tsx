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

  it('renders the suggestion on the last line when the input contains empty lines', () => {
    const { container } = render(
      <PromptGhostText
        input={'explain \n\nthe '}
        argumentHint={null}
        lastInsertedCommand={null}
        completionSuggestion="function"
      />,
    )
    const lineDivs = container.querySelectorAll('.pointer-events-none > div')
    expect(lineDivs.length).toBe(3)
    expect(screen.getByText('function')).toBeInTheDocument()
  })

  it('renders a placeholder line for each empty line in the input', () => {
    const { container } = render(
      <PromptGhostText
        input={'line one\n\nline three '}
        argumentHint={null}
        lastInsertedCommand={null}
        completionSuggestion="continues"
      />,
    )
    const lineDivs = container.querySelectorAll('.pointer-events-none > div')
    expect(lineDivs.length).toBe(3)
    expect(lineDivs[1].querySelector('br')).toBeInTheDocument()
  })
})
