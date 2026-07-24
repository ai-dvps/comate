import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useScheduledTaskStore } from './scheduled-task-store'
import type { SchedulerRunEventPayload } from '../lib/scheduled-task-events'

vi.mock('../lib/notifications', () => ({
  notifyRunFinished: vi.fn().mockResolvedValue(undefined),
  initNotificationClickHandler: vi.fn(),
  ensureNotificationPermission: vi.fn().mockResolvedValue(false),
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sampleTask = {
  id: 'task-1',
  workspaceId: 'ws-1',
  name: 'nightly',
  instruction: 'run checks',
  scheduleType: 'recurring',
  scheduleTime: null,
  cronExpr: '0 9 * * *',
  notifyDesktop: true,
  notifyInApp: true,
  notifyWecom: false,
  wecomRecipient: null,
  status: 'active',
  deletedAt: null,
  confirmedSnapshot: null,
  nextFireAt: '2026-07-25T01:00:00.000Z',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  latestRun: null,
} as const

function eventPayload(overrides: Partial<SchedulerRunEventPayload> = {}): SchedulerRunEventPayload {
  return {
    kind: 'run-finished',
    taskId: 'task-1',
    taskName: 'nightly',
    workspaceId: 'ws-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    status: 'succeeded',
    resultText: 'done',
    ...overrides,
  }
}

describe('scheduled-task-store', () => {
  beforeEach(() => {
    useScheduledTaskStore.setState({ tasks: [], loading: false, error: null, unreadCount: 0, defaultBackend: null })
    vi.restoreAllMocks()
  })

  it('fetchTasks populates the task list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ tasks: [sampleTask] })))
    await useScheduledTaskStore.getState().fetchTasks()
    expect(useScheduledTaskStore.getState().tasks).toHaveLength(1)
    expect(useScheduledTaskStore.getState().tasks[0].name).toBe('nightly')
    expect(useScheduledTaskStore.getState().loading).toBe(false)
  })

  it('fetchTasks records errors without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)))
    await useScheduledTaskStore.getState().fetchTasks()
    expect(useScheduledTaskStore.getState().error).toBe('boom')
  })

  it('createTask posts and refreshes the list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task: sampleTask }, 201))
      .mockResolvedValueOnce(jsonResponse({ tasks: [sampleTask] }))
    vi.stubGlobal('fetch', fetchMock)
    await useScheduledTaskStore.getState().createTask('ws-1', {
      name: 'nightly',
      instruction: 'run checks',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
      notifyDesktop: true,
      notifyInApp: true,
      notifyWecom: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useScheduledTaskStore.getState().tasks).toHaveLength(1)
  })

  it('confirmTask calls the confirm endpoint and refreshes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task: { ...sampleTask, status: 'active' } }))
      .mockResolvedValueOnce(jsonResponse({ tasks: [sampleTask] }))
    vi.stubGlobal('fetch', fetchMock)
    await useScheduledTaskStore.getState().confirmTask('ws-1', 'task-1')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/workspaces/ws-1/scheduled-tasks/task-1/confirm')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })
  })

  it('runNow surfaces server errors (e.g. 409) to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: '上一班次仍在执行' }, 409)))
    await expect(useScheduledTaskStore.getState().runNow('ws-1', 'task-1')).rejects.toThrow('上一班次仍在执行')
  })

  it('run-finished and draft-created events bump the unread badge and refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ tasks: [] })))
    const store = useScheduledTaskStore.getState()
    store.handleSchedulerEvent(eventPayload())
    expect(useScheduledTaskStore.getState().unreadCount).toBe(1)
    store.handleSchedulerEvent(eventPayload({ kind: 'draft-created', runId: undefined, sessionId: null }))
    expect(useScheduledTaskStore.getState().unreadCount).toBe(2)
    useScheduledTaskStore.getState().clearUnread()
    expect(useScheduledTaskStore.getState().unreadCount).toBe(0)
  })

  it('run-started events refresh without bumping unread', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ tasks: [] })))
    useScheduledTaskStore.getState().handleSchedulerEvent(eventPayload({ kind: 'run-started', status: 'running' }))
    expect(useScheduledTaskStore.getState().unreadCount).toBe(0)
  })

  it('fetchDefaultBackend records the backend for the degraded notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ backend: 'opencode' })))
    await useScheduledTaskStore.getState().fetchDefaultBackend()
    expect(useScheduledTaskStore.getState().defaultBackend).toBe('opencode')
  })

  it('fetchRuns returns the run history', async () => {
    const run = { id: 'run-1', taskId: 'task-1', sessionId: 'sess-1', status: 'succeeded', fireAt: '2026-07-24T09:00:00.000Z', startedAt: null, endedAt: null, reason: null, instructionSnapshot: 'x', createdAt: '2026-07-24T09:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ runs: [run] })))
    const runs = await useScheduledTaskStore.getState().fetchRuns('ws-1', 'task-1')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('succeeded')
  })
})
