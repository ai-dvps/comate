import { useChatStore, promptImageDraftKey } from '../stores/chat-store'
import { useBackendStore } from '../stores/backend-store'

/** Keep every existing draft intact; create only a draft session, never a user turn. */
export async function prepareSkillManagerDraft(workspaceId: string, text: string, invocationName: string): Promise<string> {
  const state = useChatStore.getState()
  let sessionId = state.activeSessionIds[workspaceId]
  const current = state.sessions[workspaceId]?.find((s) => s.id === sessionId)
  const occupied = sessionId && (state.drafts[sessionId]?.length
    || state.imageDrafts[promptImageDraftKey(workspaceId, sessionId)]?.length
    || state.isStreaming[sessionId] || state.draftQueue[sessionId])
  if (!current || occupied) {
    const result = await state.createSession(workspaceId, {
      name: 'skill-manager',
      backend: current?.backend ?? useBackendStore.getState().defaultBackend ?? 'claude',
      ...(current?.providerId ? { providerId: current.providerId } : {}),
    })
    if (!result.ok) throw new Error(result.error)
    sessionId = result.session.id
  }
  useChatStore.getState().setDraft(sessionId, `/${invocationName} ${text}`)
  return sessionId
}
