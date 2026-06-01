import { describe, it } from 'node:test'
import assert from 'node:assert'
import { shouldSubmitOnEnter } from './keyboard'

function createEvent(options: {
  key?: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
}): React.KeyboardEvent<HTMLElement> {
  return {
    key: options.key ?? 'Enter',
    shiftKey: options.shiftKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    nativeEvent: {
      isComposing: options.isComposing ?? false,
    },
  } as React.KeyboardEvent<HTMLElement>
}

describe('shouldSubmitOnEnter', () => {
  it('returns false for non-Enter keys', () => {
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ key: 'Escape' }), true), false)
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ key: 'Escape' }), false), false)
  })

  it('returns false during IME composition regardless of setting', () => {
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ isComposing: true }), true), false)
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ isComposing: true }), false), false)
    assert.strictEqual(
      shouldSubmitOnEnter(createEvent({ isComposing: true, ctrlKey: true }), true),
      false,
    )
  })

  it('returns true for Ctrl+Enter or Cmd+Enter when modifier mode is on', () => {
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ ctrlKey: true }), true), true)
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ metaKey: true }), true), true)
  })

  it('returns false for plain Enter when modifier mode is on', () => {
    assert.strictEqual(shouldSubmitOnEnter(createEvent({}), true), false)
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ shiftKey: true }), true), false)
  })

  it('returns true for plain Enter when modifier mode is off', () => {
    assert.strictEqual(shouldSubmitOnEnter(createEvent({}), false), true)
  })

  it('returns false for Shift+Enter when modifier mode is off', () => {
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ shiftKey: true }), false), false)
  })

  it('returns true for Ctrl+Enter when modifier mode is off (legacy mode only cares about Shift)', () => {
    assert.strictEqual(shouldSubmitOnEnter(createEvent({ ctrlKey: true }), false), true)
  })
})
