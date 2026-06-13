import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, CheckCircle2, AlertTriangle, AlertCircle, X } from 'lucide-react'
import { useToastStore, type Toast, type ToastSeverity } from '../stores/toast-store'
import { Button } from './ui/button'
import { cn } from './ui/utils'

const severityConfig: Record<ToastSeverity, { icon: typeof Info; iconClass: string; borderClass: string }> = {
  info: { icon: Info, iconClass: 'text-text-secondary', borderClass: '' },
  success: { icon: CheckCircle2, iconClass: 'text-success', borderClass: 'border-success/50' },
  warning: { icon: AlertTriangle, iconClass: 'text-warning', borderClass: 'border-warning/50' },
  error: { icon: AlertCircle, iconClass: 'text-destructive', borderClass: 'border-destructive/50' },
}

function ToastCard({ toast }: { toast: Toast }) {
  const { t } = useTranslation('common')
  const dismissToast = useToastStore((s) => s.dismissToast)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const config = severityConfig[toast.severity]
  const Icon = config.icon

  return (
    <div
      className={cn(
        'pointer-events-auto bg-surface border border-border rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 max-w-xs',
        'transition-all duration-200 motion-reduce:transition-none',
        config.borderClass,
        entered ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2',
      )}
    >
      <Icon className={cn('w-4 h-4 flex-shrink-0', config.iconClass)} />
      <span className="text-xs text-text-primary flex-1 break-words">{toast.message}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => dismissToast(toast.id)}
        aria-label={t('close')}
        className="flex-shrink-0 -mr-1"
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  )
}

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed top-2 right-2 z-50 flex flex-col-reverse gap-2 pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
