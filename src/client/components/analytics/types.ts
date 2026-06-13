/**
 * Shared analytics component types (see plan 2026-06-13-007, U4).
 *
 * Prop shapes for the ported chart/card components. Summary data shapes
 * (GlobalStatsSummary, WorkspaceStatsSummary) come from the server module
 * directly via `import type` — type-only imports are erased at build time
 * and don't pull server code into the client bundle.
 */

import type React from 'react'

import type { MetricColorVariant } from './analytics-utils.js'

export type SectionColorVariant = MetricColorVariant | 'accent'

export interface MetricCardProps {
  icon: React.ElementType
  label: string
  value: string | number
  subValue?: string
  trend?: number
  colorVariant: MetricColorVariant
}

export interface SectionCardProps {
  title: string
  icon?: React.ElementType
  colorVariant?: SectionColorVariant
  children: React.ReactNode
  className?: string
}
