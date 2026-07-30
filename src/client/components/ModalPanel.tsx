import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from './ui/utils'

interface ModalPanelProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  ignoreBackdropClick?: boolean
}

const TRANSITION_DURATION = 200

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
  )
}

export default function ModalPanel({
  open,
  onClose,
  children,
  className,
  ignoreBackdropClick = false,
}: ModalPanelProps) {
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Mount/unmount with exit animation so the panel can fade out before unmounting.
  useEffect(() => {
    if (open) {
      setMounted(true)
      // Double requestAnimationFrame ensures the browser sees the initial state
      // before the entering class is applied, so the transition runs.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setVisible(true)
        })
      })
    } else {
      setVisible(false)
      const timer = setTimeout(() => setMounted(false), TRANSITION_DURATION)
      return () => clearTimeout(timer)
    }
  }, [open])

  // Close on Escape unless focus is inside a text input, so panels can implement
  // their own input-specific Escape behavior (e.g. clearing search).
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTextInput(e.target)) {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open])

  if (!mounted) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex flex-col transition-opacity duration-200 ease-out',
        'motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      aria-hidden={!open}
    >
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 relative">
        <div
          className={cn(
            'absolute inset-0 bg-overlay/60 backdrop-blur-sm transition-opacity duration-200 ease-out',
            'motion-reduce:transition-none',
            visible ? 'opacity-100' : 'opacity-0',
          )}
          onClick={() => {
            if (!ignoreBackdropClick) {
              onCloseRef.current()
            }
          }}
          aria-hidden="true"
        />
        <div
          className={cn(
            'relative bg-surface border border-border flex flex-col overflow-hidden',
            'transition-all duration-200 ease-out motion-reduce:transition-none',
            visible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-2 scale-[0.98]',
            !className && 'w-full h-full max-h-[90vh] max-w-[90vw] rounded-xl shadow-2xl',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
