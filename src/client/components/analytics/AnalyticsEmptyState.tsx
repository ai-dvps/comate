/**
 * AnalyticsEmptyState — placeholder for empty/loading/error dashboard states.
 *
 * Used by the Global and Workspace views (R13: each view renders an empty
 * state when no transcript data exists for its scope).
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Loader2, AlertCircle } from 'lucide-react'

import { cn } from '../ui/utils.js'

interface AnalyticsEmptyStateProps {
  variant: 'empty' | 'loading' | 'error'
  message?: string
  className?: string
}

export const AnalyticsEmptyState: React.FC<AnalyticsEmptyStateProps> = ({
  variant,
  message,
  className,
}) => {
  const { t } = useTranslation('analytics')

  const Icon = variant === 'loading' ? Loader2 : variant === 'error' ? AlertCircle : BarChart3
  const defaultMessage =
    message ??
    (variant === 'loading'
      ? t('loading')
      : variant === 'error'
        ? t('loadError')
        : t('noData'))

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-16 text-text-tertiary',
        className,
      )}
    >
      <Icon
        className={cn(
          'w-12 h-12 mb-3',
          variant === 'loading' && 'animate-spin',
          variant === 'empty' && 'opacity-20',
          variant === 'error' && 'text-destructive',
        )}
      />
      <p className="text-sm">{defaultMessage}</p>
    </div>
  )
}

AnalyticsEmptyState.displayName = 'AnalyticsEmptyState'
