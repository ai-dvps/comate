import { useTranslation } from 'react-i18next'
import AnalyticsPanel from './AnalyticsPanel'
import SettingsPanel from './SettingsPanel'
import SkillsPage from './SkillsPage'
import TodosPanel from './TodosPanel'

export type ManagementDestination = 'todos' | 'analytics' | 'settings' | 'capabilities'

interface ManagementWorkspaceProps {
  destination: ManagementDestination
  workspaceId?: string
  onClose: () => void
  onInstallSkill?: (workspaceId: string, text: string, invocationName: string) => void
  settingsCloseRequestToken?: number
  onSettingsCloseCancelled?: () => void
  /** Deep-link target for the settings destination: seeds the workspace selection. */
  settingsWorkspaceId?: string
}

export default function ManagementWorkspace({
  destination,
  workspaceId,
  onClose,
  onInstallSkill,
  settingsCloseRequestToken,
  onSettingsCloseCancelled,
  settingsWorkspaceId,
}: ManagementWorkspaceProps) {
  const { t } = useTranslation('common')

  return (
    <section data-testid="management-workspace" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <div className="min-h-0 flex-1 overflow-hidden">
        {destination === 'todos' ? <TodosPanel isOpen onClose={onClose} presentation="embedded" /> : null}
        {destination === 'analytics' ? <AnalyticsPanel isOpen onClose={onClose} presentation="embedded" /> : null}
        {destination === 'settings' ? (
          <SettingsPanel
            isOpen
            onClose={onClose}
            presentation="embedded"
            closeRequestToken={settingsCloseRequestToken}
            onCloseCancelled={onSettingsCloseCancelled}
            initialWorkspaceId={settingsWorkspaceId}
          />
        ) : null}
        {destination === 'capabilities' && workspaceId ? (
          <SkillsPage onInstallSkill={onInstallSkill} workspaceId={workspaceId} isOpen onClose={onClose} presentation="embedded" />
        ) : null}
        {destination === 'capabilities' && !workspaceId ? (
          <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
            {t('shell.capabilitiesNeedWorkspace')}
          </div>
        ) : null}
      </div>
    </section>
  )
}
