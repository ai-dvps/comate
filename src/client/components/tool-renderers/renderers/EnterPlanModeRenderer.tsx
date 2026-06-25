import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function EnterPlanModeRenderer(_: unknown): ReactNode | null {
  void _
  return (
    <span className="text-text-secondary text-sm">Enter plan mode</span>
  )
}

registerToolRenderer('EnterPlanMode', EnterPlanModeRenderer)
