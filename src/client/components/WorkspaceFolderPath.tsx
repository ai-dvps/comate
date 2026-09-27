import { Folder } from 'lucide-react'
import { useWorkspaceStore } from '../stores/workspace-store'

interface WorkspaceFolderPathProps {
  workspaceId: string
}

export default function WorkspaceFolderPath({
  workspaceId,
}: WorkspaceFolderPathProps) {
  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId),
  )

  const folderPath = workspace?.folderPath

  if (!folderPath) {
    return null
  }

  return (
    <span
      className="status-bar-workspace flex min-w-0 items-center gap-1"
      title={folderPath}
      aria-label={folderPath}
    >
      <Folder className="size-3 shrink-0 text-text-tertiary" aria-hidden="true" />
      <span
        className="status-bar-path-value max-w-[200px] truncate text-[11px] text-text-tertiary"
        aria-hidden="true"
      >
        {folderPath}
      </span>
    </span>
  )
}
