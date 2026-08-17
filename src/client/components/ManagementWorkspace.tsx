import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Blocks, Sparkles } from 'lucide-react'
import AnalyticsPanel from './AnalyticsPanel'
import PluginSettingsPage from './PluginSettingsPage'
import SettingsPanel from './SettingsPanel'
import SkillsPage from './SkillsPage'
import TodosPanel from './TodosPanel'
import { cn } from './ui/utils'

export type ManagementDestination = 'todos' | 'analytics' | 'settings' | 'capabilities'

interface ManagementWorkspaceProps {
  destination: ManagementDestination
  workspaceId?: string
  onClose: () => void
  settingsCloseRequestToken?: number
  onSettingsCloseCancelled?: () => void
  /** Deep-link target for the settings destination: seeds the workspace selection. */
  settingsWorkspaceId?: string
}

export default function ManagementWorkspace({
  destination,
  workspaceId,
  onClose,
  settingsCloseRequestToken,
  onSettingsCloseCancelled,
  settingsWorkspaceId,
}: ManagementWorkspaceProps) {
  const { t } = useTranslation('common')
  const [capabilityType, setCapabilityType] = useState<'plugins' | 'skills'>('plugins')

  return (
    <section data-testid="management-workspace" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      {destination === 'capabilities' ? (
        <div className="flex h-11 flex-shrink-0 items-center gap-1 border-b border-border/70 bg-chrome px-4">
          <button
            type="button"
            onClick={() => setCapabilityType('plugins')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              capabilityType === 'plugins' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
            )}
          >
            <Blocks className="h-3.5 w-3.5" aria-hidden="true" /> {t('shell.plugins')}
          </button>
          <button
            type="button"
            onClick={() => setCapabilityType('skills')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              capabilityType === 'skills' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
            )}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> {t('shell.skills')}
          </button>
        </div>
      ) : null}

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
        {destination === 'capabilities' && workspaceId && capabilityType === 'plugins' ? (
          <PluginSettingsPage workspaceId={workspaceId} isOpen onClose={onClose} presentation="embedded" />
        ) : null}
        {destination === 'capabilities' && workspaceId && capabilityType === 'skills' ? (
          <SkillsPage workspaceId={workspaceId} isOpen onClose={onClose} presentation="embedded" />
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
