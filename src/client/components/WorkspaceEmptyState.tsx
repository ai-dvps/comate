import React from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase } from 'lucide-react'

import { Button } from './ui/button'

interface WorkspaceEmptyStateProps {
  onCreateWorkspace: () => void
}

export const WorkspaceEmptyState: React.FC<WorkspaceEmptyStateProps> = ({
  onCreateWorkspace,
}) => {
  const { t } = useTranslation('common')

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
      </div>
    </div>
  )
}

WorkspaceEmptyState.displayName = 'WorkspaceEmptyState'

export default WorkspaceEmptyState
