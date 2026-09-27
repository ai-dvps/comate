import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BackendId } from '../stores/backend-store'
import { AgentIcon } from './AgentIcon'

const BRAND_SIGNATURES: Record<BackendId, { viewBox: string; pathStart: string }> = {
  claude: { viewBox: '0 0 24 24', pathStart: 'm4.7144 15.9555' },
  opencode: { viewBox: '0 0 24 30', pathStart: 'M18 6H6V24H18V6Z' },
  codex: { viewBox: '0 0 22 22', pathStart: 'M8.438 8.069V6.094' },
}

describe('AgentIcon', () => {
  for (const [backendId, signature] of Object.entries(BRAND_SIGNATURES) as Array<[
    BackendId,
    (typeof BRAND_SIGNATURES)[BackendId],
  ]>) {
    it(`renders the ${backendId} brand mark`, () => {
      const { container } = render(<AgentIcon backendId={backendId} />)
      const svg = container.querySelector(`[data-agent-icon="${backendId}"] > svg`)

      expect(svg).toHaveAttribute('viewBox', signature.viewBox)
      expect(svg?.querySelector('path')?.getAttribute('d')).toMatch(
        new RegExp(`^${signature.pathStart.replaceAll('.', '\\.')}`),
      )
    })
  }

  it('keeps the brand mark when adding the lock overlay', () => {
    const { container } = render(<AgentIcon backendId="opencode" locked />)
    const icon = container.querySelector('[data-agent-icon="opencode"]')

    expect(icon?.querySelector(':scope > svg')).toHaveAttribute('viewBox', '0 0 24 30')
    expect(icon?.querySelector('[data-agent-lock] svg')).toBeInTheDocument()
  })
})
