/**
 * WorkspaceSelector — dropdown for picking a workspace on the Workspace tab.
 *
 * Renders a native <select> for v1 simplicity (R6). The reference app uses
 * a searchable list for users with many projects; comate workspaces are
 * typically few, so a native select suffices. Can be upgraded later.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Folder } from 'lucide-react'

import type { Workspace } from '../../stores/workspace-store.js'

interface WorkspaceSelectorProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelect: (workspaceId: string) => void
  disabled?: boolean
}

export const WorkspaceSelector: React.FC<WorkspaceSelectorProps> = ({
  workspaces,
  activeWorkspaceId,
  onSelect,
  disabled,
}) => {
  const { t } = useTranslation('analytics')

  if (workspaces.length === 0) {
    return (
      <div className="text-xs text-text-tertiary italic px-3 py-2">{t('noWorkspaces')}</div>
    )
  }

  return (
    <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
      <Folder className="w-3.5 h-3.5 text-text-tertiary" />
      <span className="font-medium uppercase tracking-wider">{t('workspace')}</span>
      <select
        value={activeWorkspaceId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled}
        className="bg-surface border border-border rounded-md px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent disabled:opacity-50"
      >
        {workspaces.map((ws) => (
          <option key={ws.id} value={ws.id}>
            {ws.name}
          </option>
        ))}
      </select>
    </label>
  )
}

WorkspaceSelector.displayName = 'WorkspaceSelector'
