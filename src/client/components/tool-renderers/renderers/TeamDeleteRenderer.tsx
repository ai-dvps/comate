import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function TeamDeleteRenderer(_: unknown): ReactNode | null {
  void _
  return (
    <span className="text-text-secondary text-sm">Disband team</span>
  )
}

registerToolRenderer('TeamDelete', TeamDeleteRenderer)
