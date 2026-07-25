import { useWorkspaceStore } from '@/stores/workspace-store';
import { useChatStore } from '@/stores/chat-store';

/**
 * KTD-4's jump helper: open any session in the main chat area — used by
 * notification clicks and run-history links. Run sessions are regular
 * sessions, so the standard session view (with replay) does the rendering.
 */
export function openSessionDirect(workspaceId: string, sessionId: string): void {
  const workspaceStore = useWorkspaceStore.getState();
  if (workspaceStore.openWorkspaceIds.includes(workspaceId)) {
    workspaceStore.setActiveWorkspace(workspaceId);
  } else {
    // openWorkspace appends to openWorkspaceIds and activates the workspace
    // (state updates synchronously before its best-effort /open fetch), so the
    // ChatPanel actually mounts — setActiveWorkspace alone would leave a blank
    // main area for workspaces that are not currently open (KTD-4).
    void workspaceStore.openWorkspace(workspaceId);
  }
  useChatStore.getState().setActiveSession(workspaceId, sessionId);
}
