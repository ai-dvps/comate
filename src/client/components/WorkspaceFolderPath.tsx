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
    <span className="flex items-center gap-1 min-w-0">
      <Folder className="w-3 h-3 text-text-tertiary shrink-0" />
      <span
        className="text-[11px] text-text-tertiary truncate max-w-[200px]"
        title={folderPath}
      >
        {folderPath}
      </span>
    </span>
  )
}
