import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Globe, FolderOpen, User, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { usePluginStore, type PluginScope } from '../stores/plugin-store'

interface ScopePickerModalProps {
  pluginId: string
  pluginName: string
  sourceUrl: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  workspaceId: string
}

type Phase = 'choosing' | 'installing' | 'result'

export default function ScopePickerModal({
  pluginId,
  pluginName,
  sourceUrl,
  isOpen,
  onClose,
  onSuccess,
  workspaceId,
}: ScopePickerModalProps) {
  const { t } = useTranslation('settings')
  const { installPlugin, isSaving } = usePluginStore()

  const [phase, setPhase] = useState<Phase>('choosing')
  const [selectedScope, setSelectedScope] = useState<PluginScope | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setPhase('choosing')
      setSelectedScope(null)
      setError(null)
    }
  }, [isOpen])

  // Auto-close on success after a brief delay
  useEffect(() => {
    if (phase === 'result' && !error) {
      const timer = setTimeout(() => {
        onSuccess()
        onClose()
      }, 1200)
      return () => clearTimeout(timer)
    }
  }, [phase, error, onSuccess, onClose])

  const handleInstall = useCallback(async () => {
    if (!selectedScope) return
    setPhase('installing')
    setError(null)

    const ok = await installPlugin(pluginId, sourceUrl, selectedScope, workspaceId)
    if (ok) {
      setPhase('result')
    } else {
      setError(t('plugins.installFailed', 'Failed to install plugin'))
      setPhase('result')
    }
  }, [selectedScope, pluginId, sourceUrl, workspaceId, installPlugin, t])

  const handleRetry = () => {
    setPhase('choosing')
    setError(null)
  }

  const scopes: Array<{
    id: PluginScope
    icon: typeof Globe
    title: string
    description: string
  }> = [
    {
      id: 'user',
      icon: Globe,
      title: t('plugins.scopeUser'),
      description: t('plugins.scopeUserDescription', 'Available in all your workspaces'),
    },
    {
      id: 'project',
      icon: FolderOpen,
      title: t('plugins.scopeProject'),
      description: t('plugins.scopeProjectDescription', 'Shared with collaborators in this repository'),
    },
    {
      id: 'local',
      icon: User,
      title: t('plugins.scopeLocal'),
      description: t('plugins.scopeLocalDescription', 'Only for you, in this repository'),
    },
  ]

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-surface border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-12 border-b border-border/50">
          <h3 className="text-sm font-medium text-text-primary">
            {phase === 'choosing'
              ? t('plugins.selectScope', 'Select Installation Scope')
              : phase === 'installing'
                ? t('plugins.installing', 'Installing…')
                : error
                  ? t('plugins.installFailed', 'Installation Failed')
                  : t('plugins.installSuccess', 'Installed Successfully')}
          </h3>
          {phase === 'choosing' && (
            <button
              onClick={onClose}
              className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {phase === 'choosing' && (
            <>
              <p className="text-xs text-text-secondary">
                {t('plugins.installingPlugin', { name: pluginName })}
              </p>
              <div className="space-y-2">
                {scopes.map((scope) => {
                  const Icon = scope.icon
                  const isSelected = selectedScope === scope.id
                  return (
                    <button
                      key={scope.id}
                      onClick={() => setSelectedScope(scope.id)}
                      className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
                        isSelected
                          ? 'border-accent bg-accent/5'
                          : 'border-border bg-bg hover:border-accent/30'
                      }`}
                    >
                      <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'border-accent' : 'border-text-tertiary'
                      }`}>
                        {isSelected && <div className="w-2 h-2 rounded-full bg-accent" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-accent' : 'text-text-tertiary'}`} />
                          <span className={`text-xs font-medium ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
                            {scope.title}
                          </span>
                        </div>
                        <p className="text-[11px] text-text-tertiary mt-0.5">{scope.description}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2 text-xs font-medium text-text-secondary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleInstall}
                  disabled={!selectedScope || isSaving}
                  className="flex-1 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('plugins.install', 'Install')}
                </button>
              </div>
            </>
          )}

          {phase === 'installing' && (
            <div className="flex flex-col items-center justify-center py-8 space-y-3">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
              <p className="text-sm text-text-secondary">{t('plugins.installing', 'Installing…')}</p>
              <p className="text-[11px] text-text-tertiary">{pluginName}</p>
            </div>
          )}

          {phase === 'result' && !error && (
            <div className="flex flex-col items-center justify-center py-8 space-y-3">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <p className="text-sm text-text-secondary">{t('plugins.installSuccess', 'Installed successfully')}</p>
              <p className="text-[11px] text-text-tertiary">
                {pluginName} · {selectedScope && t(`plugins.scope${selectedScope.charAt(0).toUpperCase() + selectedScope.slice(1)}`)}
              </p>
            </div>
          )}

          {phase === 'result' && error && (
            <div className="flex flex-col items-center justify-center py-6 space-y-3">
              <AlertCircle className="w-8 h-8 text-destructive" />
              <p className="text-sm text-text-secondary">{error}</p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => {
                    onClose()
                  }}
                  className="px-4 py-2 text-xs font-medium text-text-secondary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleRetry}
                  className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
                >
                  {t('plugins.retry', 'Retry')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
