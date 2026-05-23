import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function TeamDeleteRenderer(_input: unknown): ReactNode | null {
  return (
    <span className="text-text-secondary text-sm">Disband team</span>
  )
}

registerToolRenderer('TeamDelete', TeamDeleteRenderer)
