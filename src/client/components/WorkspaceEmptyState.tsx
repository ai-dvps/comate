import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase, FolderOpen } from 'lucide-react'

import { Button } from './ui/button'

interface WorkspaceItem {
  id: string
  name: string
  lastOpenedAt?: string
  updatedAt?: string
}

interface WorkspaceEmptyStateProps {
  workspaces?: WorkspaceItem[]
  onCreateWorkspace: () => void
  onSelectWorkspace: (id: string) => void
  onBrowseWorkspaces?: () => void
}

const RECENT_LIMIT = 5

function getSortTimestamp(workspace: WorkspaceItem): number {
  const raw = workspace.lastOpenedAt || workspace.updatedAt
  return raw ? new Date(raw).getTime() : 0
}

export const WorkspaceEmptyState: React.FC<WorkspaceEmptyStateProps> = ({
  workspaces = [],
  onCreateWorkspace,
  onSelectWorkspace,
  onBrowseWorkspaces,
}) => {
  const { t } = useTranslation('common')
  const hasExistingWorkspaces = workspaces.length > 0

  const recentWorkspaces = useMemo(() => {
    return [...workspaces]
      .sort((a, b) => getSortTimestamp(b) - getSortTimestamp(a))
      .slice(0, RECENT_LIMIT)
  }, [workspaces])

  const hasMoreWorkspaces = workspaces.length > RECENT_LIMIT

  return (
    <div className="flex flex-col items-center justify-center h-full px-4">
      <div className="flex flex-col items-center max-w-md text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-surface mb-4">
          <Briefcase className="w-6 h-6 text-text-tertiary" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-2">
          {t('workspaceEmptyState.title')}
        </h2>
        <p className="text-sm text-text-secondary mb-6">
          {t('workspaceEmptyState.description')}
        </p>
        <Button onClick={onCreateWorkspace}>
          {t('workspaceEmptyState.button')}
        </Button>

        {hasExistingWorkspaces && (
          <div className="mt-8 w-full text-left">
            <p className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3 text-center">
              {t('workspaceEmptyState.recentTitle')}
            </p>
            <div className="flex flex-col gap-2">
              {recentWorkspaces.map((workspace) => (
                <Button
                  key={workspace.id}
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={() => onSelectWorkspace(workspace.id)}
                >
                  <FolderOpen className="w-4 h-4 text-text-tertiary shrink-0" />
                  <span className="truncate">{workspace.name}</span>
                </Button>
              ))}
            </div>
            {hasMoreWorkspaces && onBrowseWorkspaces && (
              <button
                type="button"
                onClick={onBrowseWorkspaces}
                className="mt-3 w-full text-xs text-text-tertiary hover:text-text-secondary transition-colors"
              >
                {t('workspaceEmptyState.browseAll')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

WorkspaceEmptyState.displayName = 'WorkspaceEmptyState'

export default WorkspaceEmptyState
