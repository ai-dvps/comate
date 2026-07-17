import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import LinkifiedText from './LinkifiedText'

const openUrlMock = vi.fn()

vi.mock('../lib/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/open-url')>()
  return {
    ...actual,
    openUrlInBrowser: (...args: unknown[]) => openUrlMock(...args),
  }
})

describe('LinkifiedText', () => {
  beforeEach(() => {
    openUrlMock.mockClear()
  })

  it('renders plain text unchanged when no URLs are present', () => {
    render(<LinkifiedText text="hello world" />)
    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('renders a URL as a clickable span without link styling', () => {
    render(<LinkifiedText text="see https://example.com for details" />)
    const urlSpan = screen.getByText('https://example.com')
    expect(urlSpan.tagName).toBe('SPAN')
    expect(urlSpan).not.toHaveClass('underline')
    expect(urlSpan).not.toHaveClass('text-accent')
  })

  it('opens the URL on Cmd+click', async () => {
    const user = userEvent.setup()
    render(<LinkifiedText text="see https://example.com for details" />)
    const urlSpan = screen.getByText('https://example.com')

    await user.keyboard('{Meta>}')
    await user.click(urlSpan)
    await user.keyboard('{/Meta}')

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com')
  })

  it('opens the URL on Ctrl+click', async () => {
    const user = userEvent.setup()
    render(<LinkifiedText text="see https://example.com for details" />)
    const urlSpan = screen.getByText('https://example.com')

    await user.keyboard('{Control>}')
    await user.click(urlSpan)
    await user.keyboard('{/Control}')

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com')
  })

  it('does not open the URL on plain click', async () => {
    const user = userEvent.setup()
    render(<LinkifiedText text="see https://example.com for details" />)
    const urlSpan = screen.getByText('https://example.com')

    await user.click(urlSpan)

    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('strips trailing punctuation from the opened URL', async () => {
    const user = userEvent.setup()
    render(<LinkifiedText text="visit https://example.com." />)
    const urlSpan = screen.getByText('https://example.com.')

    await user.keyboard('{Meta>}')
    await user.click(urlSpan)
    await user.keyboard('{/Meta}')

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com')
  })

  it('renders multiple URLs independently', async () => {
    const user = userEvent.setup()
    render(<LinkifiedText text="https://a.com and https://b.com" />)

    await user.keyboard('{Meta>}')
    await user.click(screen.getByText('https://a.com'))
    await user.click(screen.getByText('https://b.com'))
    await user.keyboard('{/Meta}')

    expect(openUrlMock).toHaveBeenCalledTimes(2)
    expect(openUrlMock).toHaveBeenNthCalledWith(1, 'https://a.com')
    expect(openUrlMock).toHaveBeenNthCalledWith(2, 'https://b.com')
  })

  it('preserves search highlighting around URLs', () => {
    const ranges = [
      { start: 0, end: 3, isActive: false },
      { start: 4, end: 23, isActive: true },
    ]
    render(<LinkifiedText text="see https://example.com for details" ranges={ranges} />)

    const active = document.querySelector('[data-search-active="true"]')
    expect(active).toHaveTextContent('https://example.com')
  })
})
