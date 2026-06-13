import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert'
import { useToastStore } from './toast-store'

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
  })

  it('addToast pushes a toast with the requested severity and message', () => {
    const id = useToastStore.getState().addToast({ severity: 'error', message: 'boom', ttl: 0 })
    const toasts = useToastStore.getState().toasts
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].id, id)
    assert.equal(toasts[0].severity, 'error')
    assert.equal(toasts[0].message, 'boom')
  })

  it('addToast returns a unique id for each toast', () => {
    const id1 = useToastStore.getState().addToast({ severity: 'info', message: 'a', ttl: 0 })
    const id2 = useToastStore.getState().addToast({ severity: 'info', message: 'b', ttl: 0 })
    assert.notEqual(id1, id2)
  })

  it('two addToast calls leave both toasts in insertion order', () => {
    useToastStore.getState().addToast({ severity: 'info', message: 'first', ttl: 0 })
    useToastStore.getState().addToast({ severity: 'success', message: 'second', ttl: 0 })
    const toasts = useToastStore.getState().toasts
    assert.equal(toasts.length, 2)
    assert.equal(toasts[0].message, 'first')
    assert.equal(toasts[1].message, 'second')
  })

  it('addToast with ttl:0 does not schedule an auto-dismiss timeout', () => {
    mock.timers.enable()
    useToastStore.getState().addToast({ severity: 'info', message: 'persistent', ttl: 0 })
    mock.timers.tick(10000)
    assert.equal(useToastStore.getState().toasts.length, 1)
    mock.timers.reset()
  })

  it('dismissToast removes the toast from the stack immediately', () => {
    const id = useToastStore.getState().addToast({ severity: 'warning', message: 'gone', ttl: 0 })
    useToastStore.getState().dismissToast(id)
    assert.equal(useToastStore.getState().toasts.length, 0)
  })

  it('auto-dismiss timeout fires and removes the toast', () => {
    mock.timers.enable()
    useToastStore.getState().addToast({ severity: 'error', message: 'timed', ttl: 4000 })
    assert.equal(useToastStore.getState().toasts.length, 1)
    mock.timers.tick(4000)
    assert.equal(useToastStore.getState().toasts.length, 0)
    mock.timers.reset()
  })

  it('manual dismiss before timeout cancels the pending timeout', () => {
    mock.timers.enable()
    const id = useToastStore.getState().addToast({ severity: 'info', message: 'manual', ttl: 4000 })
    useToastStore.getState().dismissToast(id)
    assert.equal(useToastStore.getState().toasts.length, 0)
    // Tick past the original timeout — the toast must not reappear and no
    // double-remove error surfaces.
    mock.timers.tick(5000)
    assert.equal(useToastStore.getState().toasts.length, 0)
    mock.timers.reset()
  })

  it('evicts the oldest toast when the stack exceeds the cap', () => {
    // Cap is 5; add 6 ttl:0 toasts to trigger eviction of the oldest.
    useToastStore.getState().addToast({ severity: 'info', message: 'oldest', ttl: 0 })
    useToastStore.getState().addToast({ severity: 'info', message: 'two', ttl: 0 })
    useToastStore.getState().addToast({ severity: 'info', message: 'three', ttl: 0 })
    useToastStore.getState().addToast({ severity: 'info', message: 'four', ttl: 0 })
    useToastStore.getState().addToast({ severity: 'info', message: 'five', ttl: 0 })
    useToastStore.getState().addToast({ severity: 'info', message: 'newest', ttl: 0 })
    const toasts = useToastStore.getState().toasts
    assert.equal(toasts.length, 5)
    assert.equal(toasts[0].message, 'two') // oldest evicted
    assert.equal(toasts[4].message, 'newest')
  })
})
