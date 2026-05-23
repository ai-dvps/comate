import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function EnterPlanModeRenderer(_input: unknown): ReactNode | null {
  return (
    <span className="text-text-secondary text-sm">Enter plan mode</span>
  )
}

registerToolRenderer('EnterPlanMode', EnterPlanModeRenderer)
