import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSidebarKeyboardShortcut } from './use-sidebar-keyboard-shortcut'

function dispatchKeyDown(options: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent('keydown', options))
}

describe('useSidebarKeyboardShortcut', () => {
  const onToggle = vi.fn()

  beforeEach(() => {
    onToggle.mockClear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('calls onToggle for Cmd+B', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    dispatchKeyDown({ metaKey: true, code: 'KeyB' })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('calls onToggle for Ctrl+B', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    dispatchKeyDown({ ctrlKey: true, code: 'KeyB' })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('does not call onToggle for other keys', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    dispatchKeyDown({ metaKey: true, code: 'KeyN' })
    dispatchKeyDown({ ctrlKey: true, code: 'KeyB', shiftKey: true })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('ignores the shortcut when an input is focused', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    dispatchKeyDown({ metaKey: true, code: 'KeyB' })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('ignores the shortcut when a textarea is focused', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    dispatchKeyDown({ metaKey: true, code: 'KeyB' })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('ignores the shortcut when a contenteditable element is focused', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    div.focus()
    dispatchKeyDown({ metaKey: true, code: 'KeyB' })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('ignores the shortcut when a plaintext-only contenteditable element is focused', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'plaintext-only')
    document.body.appendChild(div)
    div.focus()
    dispatchKeyDown({ metaKey: true, code: 'KeyB' })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('ignores the shortcut when Shift or Alt are held', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    dispatchKeyDown({ metaKey: true, code: 'KeyB', shiftKey: true })
    dispatchKeyDown({ ctrlKey: true, code: 'KeyB', altKey: true })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('ignores repeat keydown events', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    dispatchKeyDown({ metaKey: true, code: 'KeyB', repeat: true })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('ignores events that have already been prevented', () => {
    renderHook(() => useSidebarKeyboardShortcut(onToggle))
    const event = new KeyboardEvent('keydown', {
      metaKey: true,
      code: 'KeyB',
      cancelable: true,
    })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('removes the listener on unmount', () => {
    const { unmount } = renderHook(() => useSidebarKeyboardShortcut(onToggle))
    unmount()
    dispatchKeyDown({ metaKey: true, code: 'KeyB' })
    expect(onToggle).not.toHaveBeenCalled()
  })
})
