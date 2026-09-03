import { afterEach, expect, it, vi } from 'vitest'
import { useSkillsStore } from './skills-store'

afterEach(() => vi.unstubAllGlobals())
it('keeps installed inventory scoped when workspace responses arrive out of order', async () => {
  let first!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce(Response.json({ skills: [{ name: 'current' }] })))
  const stale = useSkillsStore.getState().fetchInstalled('old')
  await useSkillsStore.getState().fetchInstalled('current')
  first(Response.json({ skills: [{ name: 'stale' }] }))
  await stale
  expect(useSkillsStore.getState().installed.map(skill => skill.name)).toEqual(['current'])
})
