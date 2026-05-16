import * as React from 'react'
import { cn } from './utils'

const variantClasses = {
  default: 'bg-accent text-white',
  secondary: 'bg-surface text-text-primary border border-border',
  outline: 'text-text-primary border border-border',
  destructive: 'bg-red-700 text-white',
} as const

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof variantClasses
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 font-semibold text-xs',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  )
}
