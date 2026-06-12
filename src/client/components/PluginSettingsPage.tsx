import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { usePluginStore } from '../stores/plugin-store'
import PluginMarketplaceTab from './PluginMarketplaceTab'
import {
  X,
  Store,
  Trash2,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Puzzle,
  Globe,
  FolderOpen,
  User,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'

interface PluginSettingsPageProps {
  workspaceId: string
  onClose: () => void
}

type PluginTab = 'installed' | 'marketplace'

export default function PluginSettingsPage({ workspaceId, onClose }: PluginSettingsPageProps) {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<PluginTab>('installed')
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  // Tracks which plugin just successfully updated, for the brief success display
  const [recentlyUpdatedId, setRecentlyUpdatedId] = useState<string | null>(null)
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    installedPlugins,
    updates,
    isSaving,
    error,
    updatingPluginId,
    updateError,
    failedUpdatePluginId,
    lastUpdatedVersion,
    fetchInstalledPlugins,
    uninstallPlugin,
    updatePlugin,
    setPluginEnabled,
    checkUpdates,
    clearError,
    clearUpdateError,
    clearUpdateState,
  } = usePluginStore()

  useEffect(() => {
    fetchInstalledPlugins(workspaceId)
    checkUpdates(workspaceId)
  }, [fetchInstalledPlugins, checkUpdates, workspaceId])

  // Cleanup on unmount: clear any in-flight update state and pending success timeout
  useEffect(() => {
    return () => {
      clearUpdateState()
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current)
        successTimeoutRef.current = null
      }
    }
  }, [clearUpdateState])

  const handleUninstall = async (pluginId: string, scope: import('../stores/plugin-store').PluginScope) => {
    const ok = await uninstallPlugin(pluginId, scope, workspaceId, true)
    if (ok) {
      setConfirmUninstall(null)
      await fetchInstalledPlugins(workspaceId)
    }
  }

  const handleUpdate = async (pluginId: string, scope: import('../stores/plugin-store').PluginScope) => {
    // Clear any previous success display
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current)
      successTimeoutRef.current = null
    }
    setRecentlyUpdatedId(null)

    const newVersion = await updatePlugin(pluginId, scope, workspaceId)
    if (newVersion !== null) {
      // Success — show brief success indicator
      setRecentlyUpdatedId(pluginId)
      await fetchInstalledPlugins(workspaceId)
      await checkUpdates(workspaceId)

      // Auto-clear success after 2 seconds
      successTimeoutRef.current = setTimeout(() => {
        setRecentlyUpdatedId(null)
        successTimeoutRef.current = null
      }, 2000)
    }
    // On failure, updateError is set in the store; the inline error UI reads it directly
  }

  const handleToggle = async (pluginId: string, scope: import('../stores/plugin-store').PluginScope, enabled: boolean) => {
    await setPluginEnabled(pluginId, scope, enabled, workspaceId)
  }

  const tabs: { id: PluginTab; label: string; icon: typeof Store }[] = [
    { id: 'installed', label: t('plugins.installedTab'), icon: Puzzle },
    { id: 'marketplace', label: t('plugins.marketplaceTab'), icon: Store },
  ]

  const hasUpdate = (pluginId: string) => updates.find((u) => u.id === pluginId)

  // Scope badge component
  const ScopeBadge = ({ scope }: { scope: import('../stores/plugin-store').PluginScope }) => {
    const configs = {
      user: { icon: Globe, color: 'bg-blue-500/10 text-blue-500', label: t('plugins.scopeUser') },
      project: { icon: FolderOpen, color: 'bg-emerald-500/10 text-emerald-500', label: t('plugins.scopeProject') },
      local: { icon: User, color: 'bg-amber-500/10 text-amber-500', label: t('plugins.scopeLocal') },
    }
    const config = configs[scope]
    const Icon = config.icon
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${config.color}`}>
        <Icon className="w-2.5 h-2.5" />
        {config.label}
      </span>
    )
  }

  return (
    <div className="fixed top-11 inset-x-0 bottom-0 z-50 flex flex-col">
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 relative">
        <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative w-full h-full max-h-[90vh] max-w-[90vw] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 h-14 flex-shrink-0 border-b border-border/50">
            <h2 className="text-sm font-medium text-text-primary">{t('plugins.title')}</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex items-center justify-between border-b border-border/50 flex-shrink-0 px-6 py-2">
            <div className="flex gap-1">
              {tabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                      activeTab === tab.id
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {tab.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="flex items-center gap-2 px-6 py-2 bg-destructive/10 border-b border-destructive/20 flex-shrink-0">
              <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
              <span className="text-[11px] text-destructive flex-1">{error}</span>
              <button onClick={clearError} className="text-[11px] text-destructive hover:underline">
                {t('common.dismiss')}
              </button>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === 'installed' && (
              <div className="space-y-3">
                {installedPlugins.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                    <Puzzle className="w-8 h-8 text-text-tertiary" />
                    <div>
                      <p className="text-sm font-medium text-text-secondary">{t('plugins.noInstalled')}</p>
                      <p className="text-xs text-text-tertiary mt-1">{t('plugins.browseMarketplaceHint')}</p>
                    </div>
                    <button
                      onClick={() => setActiveTab('marketplace')}
                      className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
                    >
                      {t('plugins.browseMarketplace')}
                    </button>
                  </div>
                ) : (
                  installedPlugins.map((plugin) => {
                    const update = hasUpdate(plugin.id)
                    const isExpanded = expandedPlugin === `${plugin.id}-${plugin.scope}`
                    return (
                      <div
                        key={`${plugin.id}-${plugin.scope}`}
                        className="bg-bg border border-border rounded-xl overflow-hidden"
                      >
                        <div className="flex items-center gap-3 px-4 py-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-text-primary truncate">
                                {plugin.displayName || plugin.name}
                              </span>
                              <ScopeBadge scope={plugin.scope} />
                              {update && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                                  {t('plugins.updateAvailable', { version: update.newVersion })}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-text-tertiary mt-0.5">
                              {plugin.id}@{plugin.version}
                              {plugin.author && ` · ${plugin.author}`}
                            </p>
                          </div>

                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {/* Update button / status */}
                            {update && (
                              <>
                                {updatingPluginId === plugin.id ? (
                                  // Updating — show spinner
                                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-accent/5">
                                    <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
                                    <span className="text-[11px] text-accent font-medium">{t('plugins.updating', 'Updating...')}</span>
                                  </div>
                                ) : recentlyUpdatedId === plugin.id ? (
                                  // Just updated — show success
                                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/10">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                    <span className="text-[11px] text-emerald-500 font-medium">
                                      {t('plugins.updatedTo', 'Updated to {{version}}', { version: lastUpdatedVersion || update.newVersion })}
                                    </span>
                                  </div>
                                ) : updateError && failedUpdatePluginId === plugin.id ? (
                                  // Error — show inline error with retry (only for this plugin, after a failed attempt)
                                  <div className="flex items-center gap-1.5">
                                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-destructive/10">
                                      <AlertCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
                                      <span className="text-[11px] text-destructive">{updateError}</span>
                                    </div>
                                    <button
                                      onClick={() => { clearUpdateError(); handleUpdate(plugin.id, plugin.scope) }}
                                      className="p-1.5 rounded-lg hover:bg-surface-hover text-accent transition-colors"
                                      title={t('plugins.retry', 'Retry')}
                                    >
                                      <RefreshCw className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                ) : (
                                  // Default — show update button
                                  <button
                                    onClick={() => handleUpdate(plugin.id, plugin.scope)}
                                    disabled={updatingPluginId !== null}
                                    className="p-1.5 rounded-lg hover:bg-surface-hover text-accent transition-colors disabled:opacity-50"
                                    title={t('plugins.update')}
                                  >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              onClick={() => handleToggle(plugin.id, plugin.scope, !plugin.enabled)}
                              disabled={isSaving || updatingPluginId === plugin.id}
                              className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-50"
                              title={plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
                            >
                              {plugin.enabled ? (
                                <ToggleRight className="w-5 h-5 text-accent" />
                              ) : (
                                <ToggleLeft className="w-5 h-5 text-text-tertiary" />
                              )}
                            </button>
                            <button
                              onClick={() => setExpandedPlugin(isExpanded ? null : `${plugin.id}-${plugin.scope}`)}
                              className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors"
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4 text-text-tertiary" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-text-tertiary" />
                              )}
                            </button>
                            <button
                              onClick={() => setConfirmUninstall(`${plugin.id}-${plugin.scope}`)}
                              disabled={isSaving || updatingPluginId === plugin.id}
                              className="p-1.5 rounded-lg hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors disabled:opacity-50"
                              title={t('plugins.uninstall')}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="px-4 pb-3 border-t border-border/50 pt-2">
                            {plugin.description && (
                              <p className="text-[11px] text-text-secondary mb-2">{plugin.description}</p>
                            )}
                            {plugin.keywords && plugin.keywords.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {plugin.keywords.map((k) => (
                                  <span
                                    key={k}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-tertiary"
                                  >
                                    {k}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="text-[10px] text-text-tertiary mt-2">
                              <p>
                                {t('plugins.installedAt')}: {new Date(plugin.installedAt).toLocaleString()}
                              </p>
                              {plugin.sourceMarketplace && (
                                <p>
                                  {t('plugins.source')}: {plugin.sourceMarketplace}
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        {confirmUninstall === `${plugin.id}-${plugin.scope}` && (
                          <div className="px-4 pb-3 border-t border-border/50 pt-2">
                            <p className="text-[11px] text-text-secondary mb-2">
                              {t('plugins.confirmUninstall', { name: plugin.displayName || plugin.name })}
                            </p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => setConfirmUninstall(null)}
                                className="px-3 py-1.5 text-[11px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                              >
                                {t('common.cancel')}
                              </button>
                              <button
                                onClick={() => handleUninstall(plugin.id, plugin.scope)}
                                disabled={isSaving}
                                className="px-3 py-1.5 text-[11px] font-medium bg-destructive hover:bg-destructive-hover text-destructive-foreground rounded-lg transition-colors disabled:opacity-50"
                              >
                                {t('plugins.uninstall')}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            )}

            {activeTab === 'marketplace' && (
              <PluginMarketplaceTab workspaceId={workspaceId} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
