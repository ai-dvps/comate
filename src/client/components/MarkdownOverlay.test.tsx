import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'
import MarkdownOverlay from './MarkdownOverlay'

describe('MarkdownOverlay', () => {
  function renderOverlay(value: string, hidden = false) {
    const ref = React.createRef<HTMLPreElement>()
    const { container } = render(
      <MarkdownOverlay ref={ref} value={value} hidden={hidden} />,
    )
    return { container, ref }
  }

  it('renders highlighted heading markup', () => {
    const { container } = renderOverlay('# Heading text')
    const html = container.querySelector('pre')?.innerHTML ?? ''
    expect(html).toContain('token title')
    expect(html).toContain('Heading text')
    expect(html).toContain('token punctuation')
  })

  it('dims inline code backticks and styles the content', () => {
    const { container } = renderOverlay('`code`')
    const html = container.querySelector('pre')?.innerHTML ?? ''
    expect(html).toContain('token code')
    expect(html).toContain('code')
    expect(html).toContain('token punctuation')
  })

  it('renders bold and italic tokens', () => {
    const { container } = renderOverlay('**bold** and *italic*')
    const html = container.querySelector('pre')?.innerHTML ?? ''
    expect(html).toContain('token bold')
    expect(html).toContain('token italic')
  })

  it('hides the overlay when hidden is true', () => {
    const { container } = renderOverlay('hello', true)
    const pre = container.querySelector('pre')
    expect(pre).toHaveStyle({ visibility: 'hidden' })
  })

  it('uses the same sans-serif font stack as the prompt textarea', () => {
    const { container } = renderOverlay('hello')
    const pre = container.querySelector('pre')
    expect(pre).toHaveClass('font-sans')
  })

  it('renders an empty overlay for empty input', () => {
    const { container } = renderOverlay('')
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toBe('​')
  })

  it('flattens HTML-like tags to a single text run so cursor alignment is preserved', () => {
    const { container } = renderOverlay('<text>')
    const html = container.querySelector('pre')?.innerHTML ?? ''
    expect(html).toBe('&lt;text&gt;<span>​</span>')
  })

  it('flattens closing HTML tags to a single text run', () => {
    const { container } = renderOverlay('</text>')
    const html = container.querySelector('pre')?.innerHTML ?? ''
    expect(html).toBe('&lt;/text&gt;<span>​</span>')
  })

  it('flattens HTML comment tags to a single text run', () => {
    const { container } = renderOverlay('<!-- comment -->')
    const html = container.querySelector('pre')?.innerHTML ?? ''
    expect(html).toBe('&lt;!-- comment --&gt;<span>​</span>')
  })
})
