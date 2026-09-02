import { beforeEach, expect, it, vi } from 'vitest'
import { useGitRepositoryStore } from './git-repository-store'

const a = { id: 'a', name: 'A', relativePath: 'a' }
const b = { id: 'b', name: 'B', relativePath: 'b' }
const response = (repositories: typeof a[], done = true, errors: { relativePath: string; message: string }[] = []) => ({
  ok: true, json: async () => ({ repositories, done, generation: 'one', errors }),
}) as Response
beforeEach(() => { useGitRepositoryStore.getState().reset(); vi.restoreAllMocks() })

it('waits for final order, selects the first result even on partial failure, and restores selection', async () => {
  global.fetch = vi.fn().mockResolvedValueOnce(response([b], false))
    .mockResolvedValueOnce(response([a, b], true, [{ relativePath: 'broken', message: 'unreadable' }]))
  await useGitRepositoryStore.getState().refresh('ws')
  expect(useGitRepositoryStore.getState().workspaces.ws.selectedId).toBe('a')
  useGitRepositoryStore.getState().select('ws', 'b')
  global.fetch = vi.fn().mockResolvedValue(response([a, b]))
  await useGitRepositoryStore.getState().refresh('ws', true)
  expect(useGitRepositoryStore.getState().workspaces.ws.selectedId).toBe('b')
  global.fetch = vi.fn().mockResolvedValue(response([a]))
  await useGitRepositoryStore.getState().refresh('ws', true)
  expect(useGitRepositoryStore.getState().workspaces.ws.selectedId).toBe('a')
})

it('shares one scan and cannot resurrect a cleared Workspace', async () => {
  let resolve!: (response: Response) => void
  global.fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done }))
  const first = useGitRepositoryStore.getState().refresh('ws')
  const second = useGitRepositoryStore.getState().refresh('ws')
  expect(fetch).toHaveBeenCalledTimes(1)
  useGitRepositoryStore.getState().clearWorkspace('ws')
  resolve(response([a]))
  await Promise.all([first, second])
  expect(useGitRepositoryStore.getState().workspaces.ws).toBeUndefined()
})
