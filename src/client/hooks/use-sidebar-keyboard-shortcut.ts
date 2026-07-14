import { useEffect } from 'react'

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  const contentEditable = element.getAttribute('contenteditable')
  if (contentEditable && contentEditable !== 'false') return true
  return false
}

export function useSidebarKeyboardShortcut(onToggle: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.shiftKey || event.altKey) return
      if (event.repeat) return
      if (event.code !== 'KeyB') return
      if (isEditableElement(document.activeElement)) return

      event.preventDefault()
      onToggle()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onToggle])
}
