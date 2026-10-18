import { create } from 'zustand'
import type { McpServerView, McpSessionApplication } from '@comate/api-contracts'

export class McpApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function mcpRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/mcp${path}`, { method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new McpApiError(typeof error.error === 'string' ? error.error : 'MCP operation failed', response.status)
  }
  return response.status === 204 ? undefined as T : response.json()
}

interface McpState {
  scope: string
  servers: McpServerView[]
  applications: McpSessionApplication[]
  loading: boolean
  error: string | null
  load(scope: string): Promise<void>
  save(input: { scope: string; id?: string; [key: string]: unknown }): Promise<void>
  remove(server: McpServerView): Promise<void>
  importConfiguration(scope: string, configuration: string): Promise<void>
  loadApplications(): Promise<void>
  updateApplications(sessionId: string, applications: McpSessionApplication[]): void
}

let requestVersion = 0
export const useMcpStore = create<McpState>((set, get) => ({
  scope: 'global', servers: [], applications: [], loading: false, error: null,
  load: async scope => {
    const version = ++requestVersion
    set({ scope, loading: true, error: null, ...(get().scope === scope ? {} : { servers: [] }) })
    try {
      const result = await mcpRequest<{ servers: McpServerView[] }>(`?scope=${encodeURIComponent(scope)}`)
      if (version === requestVersion && get().scope === scope) set({ servers: result.servers, loading: false })
    } catch (error) {
      if (version === requestVersion && get().scope === scope) set({ loading: false, error: error instanceof Error ? error.message : 'MCP operation failed' })
    }
  },
  save: async input => {
    const { id, ...body } = input
    await mcpRequest(id ? `/${id}` : '', id ? 'PUT' : 'POST', body)
    if (get().scope === input.scope) await get().load(input.scope)
  },
  remove: async server => {
    const scope = get().scope
    await mcpRequest(`/${server.id}?revision=${server.revision}`, 'DELETE')
    if (get().scope === scope) await get().load(scope)
  },
  importConfiguration: async (scope, configuration) => {
    await mcpRequest('/import', 'POST', { scope, configuration })
    if (get().scope === scope) await get().load(scope)
  },
  loadApplications: async () => {
    const result = await mcpRequest<{ applications: McpSessionApplication[] }>('/applications')
    if (JSON.stringify(result.applications) !== JSON.stringify(get().applications)) set({ applications: result.applications })
  },
  updateApplications: (sessionId, applications) => set(state => ({
    applications: [...state.applications.filter(application => application.sessionId !== sessionId), ...applications],
  })),
}))
