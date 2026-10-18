import { afterEach, it, expect, vi } from 'vitest'
import { useMcpStore } from './mcp-store'

afterEach(() => { vi.unstubAllGlobals(); useMcpStore.setState({ scope: 'global', servers: [], applications: [], error: null, loading: false }) })

it('ignores a late scope response instead of replacing the current workspace', async () => {
  let finish!: (value: unknown) => void
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ servers: [{ id: 'workspace-server' }] }) }))
  const first = useMcpStore.getState().load('global')
  await useMcpStore.getState().load('workspace:two')
  finish({ ok: true, json: async () => ({ servers: [{ id: 'global-server' }] }) })
  await first
  expect(useMcpStore.getState().servers[0].id).toBe('workspace-server')
  expect(useMcpStore.getState().scope).toBe('workspace:two')
})

it('does not retry or overwrite a conflicting configuration revision', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'MCP revision conflict' }) })
  vi.stubGlobal('fetch', fetcher)
  await expect(useMcpStore.getState().save({ scope: 'global', id: 'id', expectedRevision: 1, name: 'example', enabled: false })).rejects.toThrow('MCP revision conflict')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(useMcpStore.getState().servers).toEqual([])
})
