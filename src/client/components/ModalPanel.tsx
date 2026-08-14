import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from './ui/utils'

export type PanelPresentation = 'modal' | 'embedded'

interface ModalPanelProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  ignoreBackdropClick?: boolean
  presentation?: PanelPresentation
}

const EXIT_DURATION = 220

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
  presentation = 'modal',
}: ModalPanelProps) {
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)
  const [direction, setDirection] = useState<'enter' | 'exit'>('enter')
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Mount/unmount with enter/exit animation so the panel can animate in and out.
  useEffect(() => {
    if (presentation === 'embedded') return
    if (open) {
      setDirection('enter')
      setMounted(true)
      // Double requestAnimationFrame ensures the browser sees the initial state
      // before the entering class is applied, so the transition runs.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setVisible(true)
        })
      })
    } else {
      setDirection('exit')
      setVisible(false)
      const timer = setTimeout(() => setMounted(false), EXIT_DURATION)
      return () => clearTimeout(timer)
    }
  }, [open, presentation])

  // Close on Escape unless focus is inside a text input, so panels can implement
  // their own input-specific Escape behavior (e.g. clearing search).
  useEffect(() => {
    if (!open || presentation === 'embedded') return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTextInput(e.target)) {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open, presentation])

  if (presentation === 'embedded') {
    if (!open) return null
    return (
      <section className={cn('h-full min-h-0 w-full overflow-hidden bg-surface', className)}>
        {children}
      </section>
    )
  }

  if (!mounted) return null

  const isEnter = direction === 'enter'
  const durationClass = isEnter ? 'duration-200' : 'duration-[220ms]'
  const easingClass = isEnter ? 'ease-out' : 'ease-in'

  return (
    <div
      role="dialog"
      aria-modal={open}
      data-modal-overlay={open ? '' : undefined}
      className={cn(
        // Keep the desktop title bar uncovered so macOS users can still drag
        // the window while a panel is open.
        'fixed top-11 inset-x-0 bottom-0 z-50 flex flex-col transition-opacity',
        durationClass,
        easingClass,
        'motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      aria-hidden={!open}
    >
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 relative">
        <div
          className={cn(
            'absolute inset-0 bg-overlay/60 backdrop-blur-sm transition-opacity',
            durationClass,
            easingClass,
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
            'transition-all',
            durationClass,
            easingClass,
            'motion-reduce:transition-none',
            visible
              ? 'opacity-100 translate-y-0 scale-100'
              : isEnter
                ? 'opacity-0 -translate-y-2 scale-[0.95]'
                : 'opacity-0 translate-y-4 scale-[0.92]',
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
