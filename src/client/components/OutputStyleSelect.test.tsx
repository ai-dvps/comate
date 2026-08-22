import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import OutputStyleSelect from './OutputStyleSelect'

const appSettings = vi.hoisted(() => ({
  outputStyle: null as string | null,
  setOutputStyle: vi.fn(),
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => appSettings,
}))

vi.mock('../stores/commands-store', () => ({
  useCommandsStore: (selector: (state: unknown) => unknown) => selector({
    commandsByWorkspace: { 'ws-1': { outputStyles: [] } },
    fetchCommands: vi.fn(),
  }),
}))

describe('OutputStyleSelect', () => {
  beforeEach(() => {
    appSettings.outputStyle = null
    appSettings.setOutputStyle.mockClear()
  })

  it('does not allow a selection before the global setting has loaded', async () => {
    let resolveFetch!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })))

    render(<OutputStyleSelect workspaceId="ws-1" />)

    const trigger = screen.getByRole('button')
    expect(trigger).toBeDisabled()

    resolveFetch({ ok: true, json: async () => ({ outputStyle: 'concise' }) } as Response)

    await waitFor(() => expect(trigger).toBeEnabled())
    expect(appSettings.setOutputStyle).toHaveBeenCalledWith('concise')
  })
})
