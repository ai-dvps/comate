import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, promptImageDraftKey } from '../stores/chat-store'
import { prepareSkillManagerDraft } from './skill-manager-draft'

const createSession = vi.fn<(workspaceId: string, options: unknown) => Promise<never>>().mockResolvedValue({ ok: true, session: { id: 'management', backend: 'codex' } } as never)
beforeEach(() => {
  createSession.mockClear()
  useChatStore.setState({
    sessions: { ws: [{ id: 'existing', backend: 'codex', providerId: 'provider' }] as never },
    activeSessionIds: { ws: 'existing' }, drafts: {}, imageDrafts: {}, isStreaming: {}, draftQueue: {}, createSession,
  })
})
describe('skill-manager draft handoff', () => {
  it('fills an empty current session without creating or sending a turn', async () => {
    expect(await prepareSkillManagerDraft('ws', 'Find a design Skill', 'skill-manager~stable')).toBe('existing')
    expect(useChatStore.getState().drafts.existing).toBe('/skill-manager~stable Find a design Skill')
    expect(createSession).not.toHaveBeenCalled()
  })
  it.each(['text', 'attachment', 'streaming', 'submitting'])('preserves %s and opens a separate draft on the same backend', async (kind) => {
    const imageKey = promptImageDraftKey('ws', 'existing')
    useChatStore.setState({
      drafts: kind === 'text' ? { existing: 'Do not lose me' } : {},
      imageDrafts: kind === 'attachment' ? { [imageKey]: [{ id: 'image' }] as never } : {},
      isStreaming: kind === 'streaming' ? { existing: true } : {},
      draftQueue: kind === 'submitting' ? { existing: {} as never } : {},
    })
    const before = useChatStore.getState()
    expect(await prepareSkillManagerDraft('ws', 'Install from URL', 'skill-manager')).toBe('management')
    expect(useChatStore.getState().drafts.existing).toBe(before.drafts.existing)
    expect(useChatStore.getState().imageDrafts).toEqual(before.imageDrafts)
    expect(createSession).toHaveBeenCalledWith('ws', { name: 'skill-manager', backend: 'codex', providerId: 'provider' })
    expect(useChatStore.getState().drafts.management).toBe('/skill-manager Install from URL')
  })
  it('keeps the source workspace fixed during an asynchronous handoff', async () => {
    useChatStore.setState({ drafts: { existing: 'old' } })
    let finish!: (value: never) => void
    createSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = prepareSkillManagerDraft('ws', 'Find', 'skill-manager')
    useChatStore.setState({ activeSessionIds: { other: 'other-session' }, drafts: { existing: 'old', 'other-session': 'other draft' } })
    finish({ ok: true, session: { id: 'management' } } as never)
    await pending
    expect(useChatStore.getState().drafts['other-session']).toBe('other draft')
    expect(createSession.mock.calls[0]?.[0]).toBe('ws')
  })
})
