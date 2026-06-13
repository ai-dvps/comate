import { create } from 'zustand'

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  severity: ToastSeverity
  message: string
  ttl: number
}

export interface AddToastOptions {
  severity: ToastSeverity
  message: string
  /** Auto-dismiss delay in ms. 0 disables auto-dismiss. Defaults to DEFAULT_TTL. */
  ttl?: number
}

export interface ToastState {
  toasts: Toast[]
  addToast: (options: AddToastOptions) => string
  dismissToast: (id: string) => void
}

const DEFAULT_TTL = 4000
const MAX_TOASTS = 5

const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function clearTimer(id: string): void {
  const timer = pendingTimeouts.get(id)
  if (timer) {
    clearTimeout(timer)
    pendingTimeouts.delete(id)
  }
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  addToast: ({ severity, message, ttl = DEFAULT_TTL }) => {
    const id = generateId()
    const toast: Toast = { id, severity, message, ttl }

    const next = [...get().toasts, toast]
    // Evict the oldest toasts when the stack exceeds the cap so a burst of
    // failures cannot overflow the viewport or flood assistive tech.
    while (next.length > MAX_TOASTS) {
      const evicted = next.shift()!
      clearTimer(evicted.id)
    }
    set({ toasts: next })

    if (ttl > 0) {
      const timer = setTimeout(() => {
        pendingTimeouts.delete(id)
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
      }, ttl)
      pendingTimeouts.set(id, timer)
    }

    return id
  },
  dismissToast: (id) => {
    clearTimer(id)
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  },
}))
