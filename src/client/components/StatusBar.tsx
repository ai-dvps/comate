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
    <div className="status-bar-shell border-t border-border/10 bg-chrome">
      <div className="status-bar flex items-center justify-between px-4 py-1.5">
        <div className="status-bar-location flex min-w-0 items-center gap-2">
          <WorkspaceFolderPath workspaceId={workspaceId} />
          <WorkspaceGitBranch workspaceId={workspaceId} />
        </div>

        <div className="status-bar-metrics flex min-w-0 items-center gap-2">
          <ProviderUsageStatus sessionId={sessionId} workspaceId={workspaceId} />
          <SessionEffortBadge sessionId={sessionId} />
          <SessionTokenUsage sessionId={sessionId} />
        </div>
      </div>
    </div>
  )
}
