import { describe, it, expect } from 'vitest'
import { extractPlainText, setContent } from '../lib/contenteditable'

describe('extractPlainText', () => {
  it('returns text content for plaintext-only contenteditable', () => {
    const el = document.createElement('div')
    el.contentEditable = 'plaintext-only'
    setContent(el, 'line one\n\nline two')
    expect(extractPlainText(el)).toBe('line one\n\nline two')
  })

  it('preserves empty lines in plaintext-only contenteditable', () => {
    const el = document.createElement('div')
    el.contentEditable = 'plaintext-only'
    setContent(el, 'a\n\n\nb')
    expect(extractPlainText(el)).toBe('a\n\n\nb')
  })

  it('extracts text from contenteditable block structure without double-counting empty blocks', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML = '<div>line one</div><div><br></div><div>line two</div>'
    expect(extractPlainText(el)).toBe('line one\n\nline two\n')
  })

  it('preserves multiple empty lines in contenteditable block structure', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML =
      '<div>a</div><div><br></div><div><br></div><div>b</div>'
    expect(extractPlainText(el)).toBe('a\n\n\nb\n')
  })

  it('converts mid-block br tags to newlines', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML = '<div>line one<br>line two</div>'
    expect(extractPlainText(el)).toBe('line one\nline two\n')
  })
})
