import React from 'react'
import { CheckCircleIcon, ClockIcon, XCircleIcon } from 'lucide-react'
import type { WorkflowStatus } from '../types/message'

export interface WorkflowStatusConfig {
  labelKey: string
  badgeClass: string
  borderClass: string
  icon: React.ReactNode
}

export const workflowStatusConfig: Record<WorkflowStatus, WorkflowStatusConfig> = {
  running: {
    labelKey: 'workflowStatus.running',
    badgeClass: 'bg-warning/10 text-warning border-warning/20',
    borderClass: 'border-l-2 border-l-warning',
    icon: React.createElement(ClockIcon, { className: 'size-3.5 animate-pulse text-warning' }),
  },
  completed: {
    labelKey: 'workflowStatus.completed',
    badgeClass: 'bg-success/10 text-success border-success/20',
    borderClass: 'border-l-2 border-l-success',
    icon: React.createElement(CheckCircleIcon, { className: 'size-3.5 text-success' }),
  },
  error: {
    labelKey: 'workflowStatus.error',
    badgeClass: 'bg-destructive/10 text-destructive border-destructive/20',
    borderClass: 'border-l-2 border-l-destructive',
    icon: React.createElement(XCircleIcon, { className: 'size-3.5 text-destructive' }),
  },
  killed: {
    labelKey: 'workflowStatus.killed',
    badgeClass: 'bg-destructive/10 text-destructive border-destructive/20',
    borderClass: 'border-l-2 border-l-destructive',
    icon: React.createElement(XCircleIcon, { className: 'size-3.5 text-destructive' }),
  },
}
