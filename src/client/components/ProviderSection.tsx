import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Trash2,
  Save,
  X,
  Eye,
  EyeOff,
  Star,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Server,
} from 'lucide-react'
import { useProviderStore, type Provider } from '../stores/provider-store'
import ConfirmDialog from './ConfirmDialog'

interface ProviderFormData {
  name: string
  baseUrl: string
  authToken: string
  model: string
  defaultOpusModel: string
  defaultSonnetModel: string
  defaultHaikuModel: string
  subagentModel: string
  effortLevel: string
  customEnvVars: { key: string; value: string }[]
}

function emptyForm(): ProviderFormData {
  return {
    name: '',
    baseUrl: 'https://api.anthropic.com',
    authToken: '',
    model: '',
    defaultOpusModel: '',
    defaultSonnetModel: '',
    defaultHaikuModel: '',
    subagentModel: '',
    effortLevel: '',
    customEnvVars: [],
  }
}

function providerToForm(provider: Provider): ProviderFormData {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    authToken: provider.authToken,
    model: provider.model || '',
    defaultOpusModel: provider.defaultOpusModel || '',
    defaultSonnetModel: provider.defaultSonnetModel || '',
    defaultHaikuModel: provider.defaultHaikuModel || '',
    subagentModel: provider.subagentModel || '',
    effortLevel: provider.effortLevel || '',
    customEnvVars: provider.customEnvVars
      ? Object.entries(provider.customEnvVars).map(([key, value]) => ({ key, value }))
      : [],
  }
}

export default function ProviderSection() {
  const { t } = useTranslation('settings')
  const { providers, isLoading, isSaving, error, healthCheckId, fetchProviders, createProvider, updateProvider, deleteProvider, setDefaultProvider, runHealthCheck, clearError } = useProviderStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderFormData>(emptyForm())
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [showSaveAnywayConfirm, setShowSaveAnywayConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)

  useEffect(() => {
    if (providers.length === 0) {
      fetchProviders()
    }
  }, [fetchProviders, providers.length])

  const startCreate = useCallback(() => {
    setEditingId('new')
    setForm(emptyForm())
    setShowAdvanced(false)
    setShowToken(false)
    setFormError(null)
    clearError()
  }, [clearError])

  const startEdit = useCallback((provider: Provider) => {
    setEditingId(provider.id)
    setForm(providerToForm(provider))
    setShowAdvanced(false)
    setShowToken(false)
    setFormError(null)
    clearError()
  }, [clearError])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setForm(emptyForm())
    setFormError(null)
    clearError()
  }, [clearError])

  const handleSave = async () => {
    setFormError(null)
    if (!form.name.trim()) {
      setFormError(t('providers.nameRequired'))
      return
    }
    if (!form.baseUrl.trim()) {
      setFormError(t('providers.baseUrlRequired'))
      return
    }
    if (!form.authToken.trim()) {
      setFormError(t('providers.authTokenRequired'))
      return
    }

    let result: Provider | null = null
    if (editingId === 'new') {
      const { provider, status } = await createProvider(form)
      if (!provider && status === 422) {
        setShowSaveAnywayConfirm(true)
        return
      }
      result = provider
    } else if (editingId) {
      const { provider, status } = await updateProvider(editingId, form)
      if (!provider && status === 422) {
        setShowSaveAnywayConfirm(true)
        return
      }
      result = provider
    }

    if (result) {
      setEditingId(null)
      setForm(emptyForm())
    }
  }

  const handleSaveAnyway = async () => {
    setShowSaveAnywayConfirm(false)
    let result: Provider | null = null
    if (editingId === 'new') {
      const { provider } = await createProvider(form, { skipHealthCheck: true })
      result = provider
    } else if (editingId) {
      const { provider } = await updateProvider(editingId, form, { skipHealthCheck: true })
      result = provider
    }
    if (result) {
      setEditingId(null)
      setForm(emptyForm())
    }
  }

  const handleDelete = async (id: string) => {
    const ok = await deleteProvider(id)
    if (ok) {
      setShowDeleteConfirm(null)
      if (editingId === id) {
        setEditingId(null)
        setForm(emptyForm())
      }
    }
  }

  const updateForm = (patch: Partial<ProviderFormData>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  const updateCustomEnvVar = (index: number, patch: Partial<{ key: string; value: string }>) => {
    setForm((prev) => {
      const next = [...prev.customEnvVars]
      next[index] = { ...next[index], ...patch }
      return { ...prev, customEnvVars: next }
    })
  }

  const addCustomEnvVar = () => {
    setForm((prev) => ({
      ...prev,
      customEnvVars: [...prev.customEnvVars, { key: '', value: '' }],
    }))
  }

  const removeCustomEnvVar = (index: number) => {
    setForm((prev) => ({
      ...prev,
      customEnvVars: prev.customEnvVars.filter((_, i) => i !== index),
    }))
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-text-primary">{t('providers.title')}</h3>
        {!editingId && (
          <button
            onClick={startCreate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('providers.add')}
          </button>
        )}
      </div>

      {(error || formError) && (
        <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{formError || error}</p>
        </div>
      )}

      {isLoading && providers.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-text-tertiary" />
        </div>
      )}

      {!isLoading && providers.length === 0 && !editingId && (
        <div className="text-center py-8 border border-dashed border-border rounded-lg">
          <Server className="w-8 h-8 text-text-tertiary mx-auto mb-2" />
          <p className="text-sm text-text-secondary">{t('providers.emptyTitle')}</p>
          <p className="text-xs text-text-tertiary mt-1">{t('providers.emptyHint')}</p>
          <button
            onClick={startCreate}
            className="mt-3 px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
          >
            {t('providers.createFirst')}
          </button>
        </div>
      )}

      {/* Provider list */}
      {providers.length > 0 && !editingId && (
        <div className="space-y-2">
          {providers.map((provider) => (
            <ProviderListItem
              key={provider.id}
              provider={provider}
              isHealthChecking={healthCheckId === provider.id}
              onEdit={() => startEdit(provider)}
              onDelete={() => setShowDeleteConfirm(provider.id)}
              onSetDefault={() => setDefaultProvider(provider.id)}
              onHealthCheck={() => runHealthCheck(provider.id)}
            />
          ))}
        </div>
      )}

      {/* Edit / Create form */}
      {editingId && (
        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-text-secondary">
              {editingId === 'new' ? t('providers.add') : t('providers.edit')}
            </h4>
            <button
              onClick={cancelEdit}
              className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.name')} *</label>
              <input
                value={form.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                placeholder={t('providers.namePlaceholder')}
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.baseUrl')} *</label>
              <input
                value={form.baseUrl}
                onChange={(e) => updateForm({ baseUrl: e.target.value })}
                placeholder="https://api.anthropic.com"
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.authToken')} *</label>
            <div className="flex gap-2">
              <input
                type={showToken ? 'text' : 'password'}
                value={form.authToken}
                onChange={(e) => updateForm({ authToken: e.target.value })}
                placeholder="sk-ant-..."
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              <button
                onClick={() => setShowToken(!showToken)}
                className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.model')}</label>
            <input
              value={form.model}
              onChange={(e) => updateForm({ model: e.target.value })}
              placeholder={t('providers.modelPlaceholder')}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
          </div>

          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
          >
            {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {t('providers.advanced')}
          </button>

          {showAdvanced && (
            <div className="space-y-4 pt-2 border-t border-border/50">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.defaultOpusModel')}</label>
                  <input
                    value={form.defaultOpusModel}
                    onChange={(e) => updateForm({ defaultOpusModel: e.target.value })}
                    placeholder={t('providers.modelPlaceholder')}
                    className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.defaultSonnetModel')}</label>
                  <input
                    value={form.defaultSonnetModel}
                    onChange={(e) => updateForm({ defaultSonnetModel: e.target.value })}
                    placeholder={t('providers.modelPlaceholder')}
                    className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.defaultHaikuModel')}</label>
                  <input
                    value={form.defaultHaikuModel}
                    onChange={(e) => updateForm({ defaultHaikuModel: e.target.value })}
                    placeholder={t('providers.modelPlaceholder')}
                    className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.subagentModel')}</label>
                  <input
                    value={form.subagentModel}
                    onChange={(e) => updateForm({ subagentModel: e.target.value })}
                    placeholder={t('providers.modelPlaceholder')}
                    className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.effortLevel')}</label>
                <input
                  value={form.effortLevel}
                  onChange={(e) => updateForm({ effortLevel: e.target.value })}
                  placeholder="e.g. high"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">{t('providers.customEnvVars')}</label>
                <div className="space-y-2">
                  {form.customEnvVars.map((item, index) => (
                    <div key={index} className="flex gap-2">
                      <input
                        value={item.key}
                        onChange={(e) => updateCustomEnvVar(index, { key: e.target.value })}
                        placeholder={t('providers.envVarKey')}
                        className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                      />
                      <input
                        value={item.value}
                        onChange={(e) => updateCustomEnvVar(index, { value: e.target.value })}
                        placeholder={t('providers.envVarValue')}
                        className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                      />
                      <button
                        onClick={() => removeCustomEnvVar(index)}
                        className="p-2 rounded-lg border border-border hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addCustomEnvVar}
                    className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    {t('providers.addEnvVar')}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={cancelEdit}
              className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
            >
              {t('actions.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('unsavedDialog.saving')}
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  {t('actions.save')}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={showSaveAnywayConfirm}
        title={t('providers.saveAnywayTitle')}
        message={t('providers.saveAnywayMessage')}
        confirmLabel={t('providers.saveAnywayConfirm')}
        cancelLabel={t('actions.cancel')}
        onConfirm={handleSaveAnyway}
        onCancel={() => setShowSaveAnywayConfirm(false)}
      />

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" />
          <div className="relative bg-surface border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-medium text-text-primary">{t('providers.deleteConfirmTitle')}</h3>
                <p className="text-xs text-text-secondary mt-1">{t('providers.deleteConfirmMessage')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowDeleteConfirm(null)}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
              >
                {t('actions.cancel')}
              </button>
              <button
                onClick={() => handleDelete(showDeleteConfirm)}
                className="px-4 py-2 text-xs font-medium text-destructive-foreground bg-destructive hover:bg-destructive-hover rounded-lg transition-colors"
              >
                {t('providers.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ProviderListItem({
  provider,
  isHealthChecking,
  onEdit,
  onDelete,
  onSetDefault,
  onHealthCheck,
}: {
  provider: Provider
  isHealthChecking: boolean
  onEdit: () => void
  onDelete: () => void
  onSetDefault: () => void
  onHealthCheck: () => Promise<{ ok: boolean; error?: string }>
}) {
  const { t } = useTranslation('settings')
  const [healthStatus, setHealthStatus] = useState<{ ok: boolean; error?: string } | null>(null)

  const handleHealthCheck = async () => {
    setHealthStatus(null)
    const result = await onHealthCheck()
    setHealthStatus(result)
  }

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-bg border border-border rounded-lg group">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-shrink-0">
          {provider.isDefault ? (
            <Star className="w-4 h-4 text-warning fill-warning" />
          ) : (
            <Star className="w-4 h-4 text-text-tertiary" />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{provider.name}</span>
            {provider.isDefault && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                {t('providers.defaultBadge')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
            <span className="truncate">{provider.baseUrl}</span>
            {provider.model && <span>· {provider.model}</span>}
          </div>
          {healthStatus && (
            <div className="flex items-center gap-1 mt-1">
              {healthStatus.ok ? (
                <>
                  <CheckCircle2 className="w-3 h-3 text-success" />
                  <span className="text-[10px] text-success">{t('providers.healthy')}</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-3 h-3 text-destructive" />
                  <span className="text-[10px] text-destructive">{healthStatus.error || t('providers.unhealthy')}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {!provider.isDefault && (
          <button
            onClick={onSetDefault}
            className="p-1.5 rounded-md text-text-tertiary hover:text-warning hover:bg-warning/10 transition-colors"
            title={t('providers.setDefault')}
          >
            <Star className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={handleHealthCheck}
          disabled={isHealthChecking}
          className="p-1.5 rounded-md text-text-tertiary hover:text-success hover:bg-success/10 transition-colors disabled:opacity-40"
          title={t('providers.healthCheck')}
        >
          {isHealthChecking ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={onEdit}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
          title={t('providers.edit')}
        >
          <Server className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md text-text-tertiary hover:text-destructive hover:bg-destructive/10 transition-colors"
          title={t('providers.delete')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
