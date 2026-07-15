import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import './AskUserQuestionRenderer'
import { getToolRenderer } from '../registry'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'askUserQuestion.title': 'Ask User Question',
        'askUserQuestion.multiSelect': 'Multi-select',
        'askUserQuestion.optionFallback': 'Option {{number}}',
      }
      return labels[key] ?? key
    },
  }),
}))

const renderer = getToolRenderer('AskUserQuestion')!

const makeInput = (questionOverrides?: Record<string, unknown>) => ({
  questions: [
    {
      header: 'Deployment',
      question: 'Which deployment target should we use?',
      options: [
        { label: 'Vercel', description: 'Serverless edge functions.' },
        { label: 'Railway', description: 'Long-running containers.' },
      ],
      ...questionOverrides,
    },
  ],
})

describe('AskUserQuestionRenderer', () => {
  it('renders expanded by default and shows question text and options', () => {
    render(renderer(makeInput()))

    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    expect(screen.getByText('Deployment')).toBeInTheDocument()
    expect(screen.getByText('Which deployment target should we use?')).toBeVisible()
    expect(screen.getByText('Vercel')).toBeVisible()
    expect(screen.getByText('Serverless edge functions.')).toBeVisible()
  })

  it('collapses to the header line when the toggle is clicked', async () => {
    render(renderer(makeInput()))

    const toggle = screen.getByRole('button')
    await userEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => {
      expect(screen.queryByText('Which deployment target should we use?')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('Vercel')).not.toBeInTheDocument()
  })

  it('expands again when the collapsed header is clicked', async () => {
    render(renderer(makeInput()))

    const toggle = screen.getByRole('button')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await waitFor(() => {
      expect(screen.getByText('Which deployment target should we use?')).toBeVisible()
    })
    expect(screen.getByText('Vercel')).toBeVisible()
  })

  it('collapses and expands multiple questions as one card', async () => {
    render(
      renderer({
        questions: [
          { question: 'First question?' },
          { question: 'Second question?' },
        ],
      }),
    )

    expect(screen.getByText('First question?')).toBeVisible()
    expect(screen.getByText('Second question?')).toBeVisible()

    const toggle = screen.getByRole('button')
    await userEvent.click(toggle)

    await waitFor(() => {
      expect(screen.queryByText('First question?')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('Second question?')).not.toBeInTheDocument()

    await userEvent.click(toggle)
    await waitFor(() => {
      expect(screen.getByText('First question?')).toBeVisible()
    })
    expect(screen.getByText('Second question?')).toBeVisible()
  })

  it('renders a multi-select badge when multiSelect is true', () => {
    render(renderer(makeInput({ multiSelect: true })))
    expect(screen.getByText('Multi-select')).toBeInTheDocument()
  })

  it('renders nothing for invalid or missing input', () => {
    const { container } = render(renderer(null))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when questions is empty', () => {
    const { container } = render(renderer({ questions: [] }))
    expect(container).toBeEmptyDOMElement()
  })
})
