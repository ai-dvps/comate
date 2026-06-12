import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  BookOpen,
  Search,
  Trash2,
  RefreshCw,
  Globe,
  FolderOpen,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Download,
  Link2,
  Sparkles,
} from 'lucide-react'
import { useSkillsStore, type SkillScope, type InstalledSkill, type SearchSkill } from '../stores/skills-store'
import SkillInstallModal from './SkillInstallModal'

interface SkillsPageProps {
  workspaceId: string
  onClose: () => void
}

type SkillTab = 'installed' | 'search'

/**
 * Full-screen overlay for the Skills surface. Mirrors PluginSettingsPage:
 *   - `fixed top-11 inset-x-0 bottom-0 z-50` overlay with backdrop blur
 *   - Inner rounded card with header / tab strip / scrollable content
 *   - Two tabs: `installed` (default) and `search`
 *
 * Differences from PluginSettingsPage (Design #1, #2, #4, #6):
 *   - No enable/disable toggle (skills are always-on)
 *   - No separate "update-available" check — `update` re-fetches the source
 *   - Search runs against skills.sh via /api/skills/search
 *   - Add-skill entry points (URL input + "Add from search result") open
 *     the SkillInstallModal which carries the multi-select + scope picker
 *     + phase machine per U7.
 *   - Legacy symlinked skills show a "symlinked (legacy)" tag and refuse
 *     Update via the store's update-error channel (Design #6).
 */
export default function SkillsPage({ workspaceId, onClose }: SkillsPageProps) {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<SkillTab>('installed')
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [installModal, setInstallModal] = useState<{ open: boolean; source: string }>({
    open: false,
    source: '',
  })
  const [urlInput, setUrlInput] = useState('')
  const [showUrlBox, setShowUrlBox] = useState(false)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [recentlyUpdatedName, setRecentlyUpdatedName] = useState<string | null>(null)

  const {
    installed,
    searchResults,
    isFetchingInstalled,
    isSearching,
    isSaving,
    error,
    updatingSkillName,
    updateError,
    failedUpdateSkillName,
    fetchInstalled,
    search,
    uninstall,
    update,
    updateAll,
    clearError,
    clearUpdateError,
  } = useSkillsStore()

  // Initial fetch of installed skills
  useEffect(() => {
    fetchInstalled(workspaceId)
  }, [fetchInstalled, workspaceId])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current)
      clearUpdateError()
    }
  }, [clearUpdateError])

  // Debounced search — 300ms, mirrors PluginMarketplaceTab pattern
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(() => {
        search(value)
      }, 300)
    },
    [search]
  )

  const clearSearch = useCallback(() => {
    setSearchInput('')
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    search('')
  }, [search])

  const handleUninstall = async (skill: InstalledSkill) => {
    const ok = await uninstall({ skillName: skill.name, scope: skill.scope, workspaceId })
    if (ok) {
      setConfirmUninstall(null)
    }
  }

  const handleUpdate = async (skill: InstalledSkill) => {
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current)
      successTimeoutRef.current = null
    }
    setRecentlyUpdatedName(null)

    const ok = await update({ skillName: skill.name, scope: skill.scope, workspaceId })
    if (ok) {
      setRecentlyUpdatedName(skill.name)
      successTimeoutRef.current = setTimeout(() => {
        setRecentlyUpdatedName(null)
        successTimeoutRef.current = null
      }, 2000)
    }
    // On failure, updateError/failedUpdateSkillName flow through the store.
  }

  const handleUpdateAll = async () => {
    await updateAll(workspaceId)
  }

  const openInstallFromUrl = () => {
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setInstallModal({ open: true, source: trimmed })
    setUrlInput('')
    setShowUrlBox(false)
  }

  const openInstallFromSearch = (skill: SearchSkill) => {
    setInstallModal({ open: true, source: skill.source })
  }

  const handleInstallModalClose = () => {
    setInstallModal({ open: false, source: '' })
  }

  const handleInstalled = async () => {
    setInstallModal({ open: false, source: '' })
    await fetchInstalled(workspaceId)
  }

  // Check whether a search result is already installed (any scope)
  const isSearchResultInstalled = (skillName: string): boolean => {
    return installed.some((s) => s.name === skillName)
  }

  const tabs: { id: SkillTab; label: string; icon: typeof BookOpen }[] = [
    { id: 'installed', label: t('skills.installedTab'), icon: BookOpen },
    { id: 'search', label: t('skills.searchTab'), icon: Search },
  ]

  return (
    <div className="fixed top-11 inset-x-0 bottom-0 z-50 flex flex-col">
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 relative">
        <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative w-full h-full max-h-[90vh] max-w-[90vw] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 h-14 flex-shrink-0 border-b border-border/50">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-medium text-text-primary">{t('skills.title')}</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
              aria-label={t('common.cancel', 'Close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs + actions */}
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
            <div className="flex items-center gap-1.5">
              {activeTab === 'installed' && installed.length > 0 && (
                <button
                  onClick={handleUpdateAll}
                  disabled={isSaving || updatingSkillName !== null}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
                  title={t('skills.updateAll')}
                >
                  <RefreshCw className={`w-3 h-3 ${isSaving ? 'animate-spin' : ''}`} />
                  {t('skills.updateAll')}
                </button>
              )}
              <button
                onClick={() => setShowUrlBox((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                title={t('skills.addFromUrl')}
              >
                <Link2 className="w-3 h-3" />
                {t('skills.addFromUrl')}
              </button>
            </div>
          </div>

          {/* URL install box (toggled) */}
          {showUrlBox && (
            <div className="flex gap-2 px-6 py-2 bg-bg border-b border-border/50">
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openInstallFromUrl()
                }}
                placeholder={t('skills.urlPlaceholder', 'owner/repo or https://github.com/owner/repo')}
                className="flex-1 px-3 py-1.5 text-xs bg-surface border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                autoFocus
              />
              <button
                onClick={openInstallFromUrl}
                disabled={!urlInput.trim()}
                className="px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors disabled:opacity-50"
              >
                {t('skills.continue', 'Continue')}
              </button>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="flex items-center gap-2 px-6 py-2 bg-destructive/10 border-b border-destructive/20 flex-shrink-0">
              <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
              <span className="text-[11px] text-destructive flex-1">{error}</span>
              <button onClick={clearError} className="text-[11px] text-destructive hover:underline">
                {t('common.dismiss', 'Dismiss')}
              </button>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* Installed tab */}
            {activeTab === 'installed' && (
              <div className="space-y-3">
                {isFetchingInstalled && installed.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 text-text-tertiary animate-spin" />
                  </div>
                ) : installed.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                    <BookOpen className="w-8 h-8 text-text-tertiary" />
                    <div>
                      <p className="text-sm font-medium text-text-secondary">{t('skills.noInstalled')}</p>
                      <p className="text-xs text-text-tertiary mt-1">{t('skills.searchHint')}</p>
                    </div>
                    <button
                      onClick={() => setActiveTab('search')}
                      className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
                    >
                      {t('skills.openSearch')}
                    </button>
                  </div>
                ) : (
                  installed.map((skill) => (
                    <InstalledSkillCard
                      key={`${skill.name}-${skill.scope}`}
                      skill={skill}
                      isSaving={isSaving}
                      updating={updatingSkillName === skill.name}
                      recentlyUpdated={recentlyUpdatedName === skill.name}
                      showUpdateError={failedUpdateSkillName === skill.name && !!updateError}
                      updateError={updateError}
                      confirmUninstall={confirmUninstall === `${skill.name}-${skill.scope}`}
                      onConfirmUninstall={() => setConfirmUninstall(`${skill.name}-${skill.scope}`)}
                      onCancelUninstall={() => setConfirmUninstall(null)}
                      onUninstall={() => handleUninstall(skill)}
                      onUpdate={() => handleUpdate(skill)}
                      onClearUpdateError={clearUpdateError}
                      t={t}
                    />
                  ))
                )}
              </div>
            )}

            {/* Search tab */}
            {activeTab === 'search' && (
              <div className="space-y-4">
                {/* Search input */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
                  <input
                    value={searchInput}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    placeholder={t('skills.searchPlaceholder')}
                    className="w-full pl-9 pr-8 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                  {searchInput && (
                    <button
                      onClick={clearSearch}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-surface-hover text-text-tertiary"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Searching indicator */}
                {isSearching && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 text-text-tertiary animate-spin" />
                  </div>
                )}

                {/* Empty states */}
                {!isSearching && searchResults.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                    <Search className="w-8 h-8 text-text-tertiary" />
                    <div>
                      <p className="text-sm font-medium text-text-secondary">
                        {searchInput ? t('skills.noResults') : t('skills.startSearching')}
                      </p>
                      <p className="text-xs text-text-tertiary mt-1">{t('skills.searchHint')}</p>
                    </div>
                  </div>
                )}

                {/* Results */}
                {!isSearching && searchResults.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {searchResults.map((skill) => {
                      const isInstalled = isSearchResultInstalled(skill.name)
                      return (
                        <div
                          key={skill.id}
                          className="bg-bg border border-border rounded-xl p-4 hover:border-accent/30 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <h3 className="text-sm font-medium text-text-primary truncate">{skill.name}</h3>
                              <p className="text-[11px] text-text-tertiary mt-0.5 truncate">{skill.source}</p>
                              <p className="text-[10px] text-text-tertiary mt-1">
                                {t('skills.installsCount', { count: skill.installs })}
                              </p>
                            </div>
                            <button
                              onClick={() => openInstallFromSearch(skill)}
                              disabled={isSaving || isInstalled}
                              className="px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                              title={isInstalled ? t('skills.alreadyInstalled') : t('skills.install')}
                            >
                              {isInstalled ? (
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              ) : (
                                <Download className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {installModal.open && (
        <SkillInstallModal
          source={installModal.source}
          workspaceId={workspaceId}
          onClose={handleInstallModalClose}
          onInstalled={handleInstalled}
        />
      )}
    </div>
  )
}

/**
 * Installed skill card with scope badge, legacy-symlink tag, Remove/Update
 * action buttons, and inline update-error display.
 */
interface InstalledSkillCardProps {
  skill: InstalledSkill
  isSaving: boolean
  updating: boolean
  recentlyUpdated: boolean
  showUpdateError: boolean
  updateError: string | null
  confirmUninstall: boolean
  onConfirmUninstall: () => void
  onCancelUninstall: () => void
  onUninstall: () => void
  onUpdate: () => void
  onClearUpdateError: () => void
  t: ReturnType<typeof useTranslation>['t']
}

function InstalledSkillCard({
  skill,
  isSaving,
  updating,
  recentlyUpdated,
  showUpdateError,
  updateError,
  confirmUninstall,
  onConfirmUninstall,
  onCancelUninstall,
  onUninstall,
  onUpdate,
  onClearUpdateError,
  t,
}: InstalledSkillCardProps) {
  const scopeConfig: Record<SkillScope, { icon: typeof Globe; color: string; label: string }> = {
    global: {
      icon: Globe,
      color: 'bg-blue-500/10 text-blue-500',
      label: t('skills.scopeGlobal'),
    },
    project: {
      icon: FolderOpen,
      color: 'bg-emerald-500/10 text-emerald-500',
      label: t('skills.scopeProject'),
    },
  }
  const scope = scopeConfig[skill.scope]
  const ScopeIcon = scope.icon

  return (
    <div className="bg-bg border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary truncate">{skill.name}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${scope.color}`}>
              <ScopeIcon className="w-2.5 h-2.5" />
              {scope.label}
            </span>
            {skill.isLegacySymlink && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                {t('skills.legacySymlink')}
              </span>
            )}
            {skill.updatedAt && (
              <span className="text-[10px] text-text-tertiary">
                {t('skills.updatedAt', { date: new Date(skill.updatedAt).toLocaleDateString() })}
              </span>
            )}
          </div>
          <p className="text-[11px] text-text-tertiary mt-0.5 truncate">
            {t('skills.sourceLabel')}: {skill.source}
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Update button / status */}
          {updating ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-accent/5">
              <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
              <span className="text-[11px] text-accent font-medium">{t('skills.updating')}</span>
            </div>
          ) : recentlyUpdated ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/10">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-[11px] text-emerald-500 font-medium">{t('skills.updatedOk')}</span>
            </div>
          ) : showUpdateError && updateError ? (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-destructive/10 max-w-[200px]">
                <AlertCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
                <span className="text-[11px] text-destructive truncate" title={updateError}>{updateError}</span>
              </div>
              <button
                onClick={() => {
                  onClearUpdateError()
                  onUpdate()
                }}
                className="p-1.5 rounded-lg hover:bg-surface-hover text-accent transition-colors"
                title={t('skills.retry')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={onUpdate}
              disabled={isSaving || updating}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-accent transition-colors disabled:opacity-50"
              title={t('skills.update')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={onConfirmUninstall}
            disabled={isSaving || updating}
            className="p-1.5 rounded-lg hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors disabled:opacity-50"
            title={t('skills.uninstall')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {confirmUninstall && (
        <div className="px-4 pb-3 border-t border-border/50 pt-2">
          <p className="text-[11px] text-text-secondary mb-2">
            {t('skills.confirmUninstall', { name: skill.name })}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onCancelUninstall}
              className="px-3 py-1.5 text-[11px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={onUninstall}
              disabled={isSaving}
              className="px-3 py-1.5 text-[11px] font-medium bg-destructive hover:bg-destructive-hover text-destructive-foreground rounded-lg transition-colors disabled:opacity-50"
            >
              {t('skills.uninstall')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
