import WorkspaceFolderPath from './WorkspaceFolderPath'
import WorkspaceGitBranch from './WorkspaceGitBranch'
import ProviderUsageStatus from './ProviderUsageStatus'
import SessionEffortBadge from './SessionEffortBadge'
import SessionTokenUsage from './SessionTokenUsage'

interface StatusBarProps {
  sessionId: string
  workspaceId: string
}

export default function StatusBar({
  sessionId,
  workspaceId,
}: StatusBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-1.5 border-t border-border/10 gap-3 bg-chrome">
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <WorkspaceFolderPath workspaceId={workspaceId} />
        <WorkspaceGitBranch workspaceId={workspaceId} />
      </div>

      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <ProviderUsageStatus sessionId={sessionId} workspaceId={workspaceId} />
        <SessionEffortBadge sessionId={sessionId} />
        <SessionTokenUsage sessionId={sessionId} />
      </div>
    </div>
  )
}
