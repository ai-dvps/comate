import { describe, it, expect } from 'vitest'
import {
  createRangeFromPlainTextOffsets,
  extractPlainText,
  setContent,
} from '../lib/contenteditable'

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

describe('createRangeFromPlainTextOffsets', () => {
  it('maps offsets through plaintext-only newlines', () => {
    const el = document.createElement('div')
    el.contentEditable = 'plaintext-only'
    setContent(el, 'one\n/review @src/app.ts')

    expect(createRangeFromPlainTextOffsets(el, 4, 11)?.toString()).toBe('/review')
    expect(createRangeFromPlainTextOffsets(el, 12, 23)?.toString()).toBe('@src/app.ts')
  })

  it('maps offsets through fallback block and br newlines', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML = '<div>first</div><div>/review<br>@file</div>'

    expect(extractPlainText(el)).toBe('first\n/review\n@file\n')
    expect(createRangeFromPlainTextOffsets(el, 6, 13)?.toString()).toBe('/review')
    expect(createRangeFromPlainTextOffsets(el, 14, 19)?.toString()).toBe('@file')
  })

  it('rejects invalid or synthetic-newline-only ranges', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.innerHTML = '<div>one</div><div>two</div>'

    expect(createRangeFromPlainTextOffsets(el, -1, 2)).toBeNull()
    expect(createRangeFromPlainTextOffsets(el, 4, 4)).toBeNull()
  })
})
