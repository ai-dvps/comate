import { useWorkspaceStore } from '@/stores/workspace-store';
import { useChatStore } from '@/stores/chat-store';

/**
 * KTD-4's jump helper: open any session in the main chat area — used by
 * notification clicks and run-history links. Run sessions are regular
 * sessions, so the standard session view (with replay) does the rendering.
 */
export function openSessionDirect(workspaceId: string, sessionId: string): void {
  useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
  useChatStore.getState().setActiveSession(workspaceId, sessionId);
}
