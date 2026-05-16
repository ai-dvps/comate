import * as React from 'react'
import { cn } from './utils'

const variantClasses = {
  default: 'bg-accent text-white hover:bg-accent-hover',
  ghost: 'hover:bg-surface-hover hover:text-text-primary',
  outline: 'border border-border bg-transparent hover:bg-surface-hover',
  secondary: 'bg-surface hover:bg-surface-hover text-text-primary',
  destructive: 'bg-red-700 text-white hover:bg-red-800',
} as const

const sizeClasses = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-10 px-6',
  icon: 'h-9 w-9',
  'icon-sm': 'h-7 w-7',
} as const

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantClasses
  size?: keyof typeof sizeClasses
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
