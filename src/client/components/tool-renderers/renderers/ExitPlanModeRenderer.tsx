import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function ExitPlanModeRenderer(_: unknown): ReactNode | null {
  void _
  return (
    <span className="text-text-secondary text-sm">Exit plan mode</span>
  )
}

registerToolRenderer('ExitPlanMode', ExitPlanModeRenderer)
