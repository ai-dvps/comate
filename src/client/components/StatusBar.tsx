import WorkspaceFolderPath from './WorkspaceFolderPath'
import WorkspaceGitBranch from './WorkspaceGitBranch'
import SessionTokenUsage from './SessionTokenUsage'
import ContextUsagePanel from './ContextUsagePanel'

interface StatusBarProps {
  sessionId: string
  workspaceId: string
  modelUsage?: Record<string, unknown>
}

export default function StatusBar({
  sessionId,
  workspaceId,
  modelUsage,
}: StatusBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-1.5 border-t border-border/20 gap-3">
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <WorkspaceFolderPath workspaceId={workspaceId} />
        <WorkspaceGitBranch workspaceId={workspaceId} />
      </div>

      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <SessionTokenUsage
          sessionId={sessionId}
          workspaceId={workspaceId}
          modelUsage={modelUsage}
        />
        <ContextUsagePanel sessionId={sessionId} workspaceId={workspaceId} />
      </div>
    </div>
  )
}
