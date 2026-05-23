import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function ExitPlanModeRenderer(_input: unknown): ReactNode | null {
  return (
    <span className="text-text-secondary text-sm">Exit plan mode</span>
  )
}

registerToolRenderer('ExitPlanMode', ExitPlanModeRenderer)
