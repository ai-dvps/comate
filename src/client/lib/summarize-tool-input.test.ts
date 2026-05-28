import { describe, it } from 'node:test'
import assert from 'node:assert'
import { summarizeToolInput } from './summarize-tool-input'

describe('summarizeToolInput', () => {
  it('returns undefined for null', () => {
    assert.strictEqual(summarizeToolInput(null), undefined)
  })

  it('returns undefined for undefined', () => {
    assert.strictEqual(summarizeToolInput(undefined), undefined)
  })

  it('returns undefined for a plain string', () => {
    assert.strictEqual(summarizeToolInput('hello'), 'hello')
  })

  it('prefers description when available', () => {
    assert.strictEqual(
      summarizeToolInput({ description: 'Run tests' }),
      'Run tests',
    )
  })

  it('truncates long description', () => {
    const long = 'a'.repeat(200)
    assert.strictEqual(
      summarizeToolInput({ description: long }),
      'a'.repeat(120) + '…',
    )
  })

  it('extracts question text from AskUserQuestion shape', () => {
    assert.strictEqual(
      summarizeToolInput({
        questions: [{ question: 'What would you like to do?' }],
      }),
      'What would you like to do?',
    )
  })

  it('prefers question over header', () => {
    assert.strictEqual(
      summarizeToolInput({
        questions: [{ header: 'Choose an action', question: 'What next?' }],
      }),
      'What next?',
    )
  })

  it('falls back to header when question is missing', () => {
    assert.strictEqual(
      summarizeToolInput({
        questions: [{ header: 'Choose an action' }],
      }),
      'Choose an action',
    )
  })

  it('truncates long question text', () => {
    const long = 'a'.repeat(200)
    assert.strictEqual(
      summarizeToolInput({
        questions: [{ question: long }],
      }),
      'a'.repeat(120) + '…',
    )
  })

  it('falls back to firstKey when questions array is empty', () => {
    assert.strictEqual(
      summarizeToolInput({ questions: [] }),
      'questions: ',
    )
  })

  it('falls back to firstKey when first question is malformed', () => {
    assert.strictEqual(
      summarizeToolInput({ questions: [{}] }),
      'questions: [object Object]',
    )
  })

  it('falls back to firstKey when first question is not an object', () => {
    assert.strictEqual(
      summarizeToolInput({ questions: ['not-an-object'] }),
      'questions: not-an-object',
    )
  })

  it('returns primary key value for known keys', () => {
    assert.strictEqual(
      summarizeToolInput({ command: 'git status' }),
      'git status',
    )
  })

  it('appends secondary key when short', () => {
    assert.strictEqual(
      summarizeToolInput({ code: 'console.log(1)', language: 'ts' }),
      'console.log(1) → ts',
    )
  })

  it('returns content when short and no primary key matches', () => {
    assert.strictEqual(
      summarizeToolInput({ content: 'short content' }),
      'short content',
    )
  })

  it('falls back to firstKey for generic objects', () => {
    assert.strictEqual(
      summarizeToolInput({ foo: 'bar' }),
      'foo: bar',
    )
  })

  it('truncates long fallback values', () => {
    const long = 'a'.repeat(200)
    assert.strictEqual(
      summarizeToolInput({ foo: long }),
      'foo: ' + 'a'.repeat(120) + '…',
    )
  })
})
