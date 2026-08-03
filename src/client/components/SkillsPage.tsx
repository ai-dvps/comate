import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent } from 'react'
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
  SlidersHorizontal,
  Languages,
  KeyRound,
  ArrowDownUp,
  RotateCcw,
  Boxes,
  Building2,
  ChevronDown,
  Grid2X2,
  List,
} from 'lucide-react'
import {
  useSkillsStore,
  type SkillScope,
  type InstalledSkill,
  type SearchSkill,
  type SkillSearchFilters,
  type SkillScene,
} from '../stores/skills-store'
import SkillInstallModal from './SkillInstallModal'
import ModalPanel from './ModalPanel'
import ExpertPackagesView from './skills/ExpertPackagesView'
import EnterpriseZoneView from './skills/EnterpriseZoneView'
import SkillProviderFilter from './skills/SkillProviderFilter'
import { useExpertPackagesStore } from '../stores/expert-packages-store'

interface SkillsPageProps {
  workspaceId: string
  isOpen: boolean
  onClose: () => void
}

type SkillTab = 'installed' | 'search' | 'expert-packages' | 'enterprise-zone'
type InstalledViewMode = 'cards' | 'list'

/**
 * Full-screen overlay for the Skills surface. Mirrors PluginSettingsPage:
 *   - `fixed top-11 inset-x-0 bottom-0 z-50` overlay with backdrop blur
 *   - Inner rounded card with header / tab strip / scrollable content
 *   - Four peer tabs: `installed` (default), `search`, Expert Packages, and Enterprise Zone
 *
 * Differences from PluginSettingsPage (Design #1, #2, #4, #6):
 *   - No enable/disable toggle (skills are always-on)
 *   - No separate "update-available" check — `update` re-fetches the source
 *   - Search federates live registry queries via /api/skills/search
 *   - Add-skill entry points (URL input + "Add from search result") open
 *     the SkillInstallModal which carries the multi-select + scope picker
 *     + phase machine per U7.
 *   - Legacy symlinked skills show a "symlinked (legacy)" tag and refuse
 *     Update via the store's update-error channel (Design #6).
 */
export default function SkillsPage({ workspaceId, isOpen, onClose }: SkillsPageProps) {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<SkillTab>('installed')
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [searchFilters, setSearchFilters] = useState<SkillSearchFilters>({ sort: 'score' })
  const [installModal, setInstallModal] = useState<{ open: boolean; source: string }>({
    open: false,
    source: '',
  })
  const [urlInput, setUrlInput] = useState('')
  const [showUrlBox, setShowUrlBox] = useState(false)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const providerCheckBlockedSearch = useRef(false)
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [recentlyUpdatedName, setRecentlyUpdatedName] = useState<string | null>(null)
  const [packageAction, setPackageAction] = useState<{ slug: string; type: 'update' | 'uninstall' } | null>(null)
  const [expandedPackageKeys, setExpandedPackageKeys] = useState<Set<string>>(() => new Set())
  const [installedSearchInput, setInstalledSearchInput] = useState('')
  const [installedViewMode, setInstalledViewMode] = useState<InstalledViewMode>('cards')

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
    searchProviders,
    selectedSearchProviderIds,
    searchProviderBlockReason,
    lastSearchIncompleteProviderIds,
    isSearchProviderPreferenceInitialized,
    fetchInstalled,
    search,
    checkSearchProviders,
    selectAllSearchProviders,
    uninstall,
    update,
    updateAll,
    clearError,
    clearUpdateError,
  } = useSkillsStore()

  // Initial fetch of installed skills when the panel opens.
  useEffect(() => {
    if (!isOpen) return
    fetchInstalled(workspaceId)
  }, [isOpen, fetchInstalled, workspaceId])

  useEffect(() => {
    if (!isOpen) useExpertPackagesStore.getState().reset()
  }, [isOpen])

  useEffect(() => {
    if (isOpen && activeTab === 'search') void checkSearchProviders()
  }, [activeTab, checkSearchProviders, isOpen])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current)
      clearUpdateError()
    }
  }, [clearUpdateError])

  // Debounced search — 300ms, mirrors PluginMarketplaceTab pattern
  const scheduleSearch = useCallback(
    (value: string, filters: SkillSearchFilters) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(() => {
        search(value, filters)
      }, 300)
    },
    [search]
  )

  useEffect(() => {
    if (searchProviderBlockReason === 'checking' && searchInput) {
      providerCheckBlockedSearch.current = true
      return
    }
    if (providerCheckBlockedSearch.current && isSearchProviderPreferenceInitialized && searchInput) {
      providerCheckBlockedSearch.current = false
      scheduleSearch(searchInput, searchFilters)
    }
  }, [
    isSearchProviderPreferenceInitialized,
    scheduleSearch,
    searchFilters,
    searchInput,
    searchProviderBlockReason,
  ])

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      scheduleSearch(value, searchFilters)
    },
    [scheduleSearch, searchFilters]
  )

  const updateSearchFilters = (updates: Partial<SkillSearchFilters>) => {
    const next = { ...searchFilters, ...updates }
    setSearchFilters(next)
    scheduleSearch(searchInput, next)
  }

  const clearSearchFilters = () => {
    const next: SkillSearchFilters = { sort: 'score' }
    selectAllSearchProviders()
    setSearchFilters(next)
    scheduleSearch(searchInput, next)
  }

  const handleProviderSelectionChange = () => scheduleSearch(searchInput, searchFilters)

  const clearSearch = useCallback(() => {
    setSearchInput('')
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    search('', searchFilters)
  }, [search, searchFilters])

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

  const runPackageAction = async (skill: InstalledSkill, type: 'update' | 'uninstall') => {
    const packageSlug = skill.source.slice('skillhub-package:'.length)
    if (!packageSlug) return
    setPackageAction({ slug: packageSlug, type })
    try {
      const response = await fetch(`/api/skills/expert-packages/${encodeURIComponent(packageSlug)}/${type === 'update' ? 'install' : 'uninstall'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: skill.scope, workspaceId, ...(type === 'update' ? { force: true } : {}) }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `Unable to ${type} Expert Package`)
      }
      if (type === 'update') {
        setRecentlyUpdatedName(skill.name)
        successTimeoutRef.current = setTimeout(() => setRecentlyUpdatedName(null), 2000)
      } else {
        setConfirmUninstall(null)
      }
      await fetchInstalled(workspaceId)
    } catch (actionError) {
      useSkillsStore.setState({ error: actionError instanceof Error ? actionError.message : `Unable to ${type} Expert Package` })
    } finally {
      setPackageAction(null)
    }
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
    setInstallModal({ open: true, source: skill.installSource })
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

  const hasActiveSearchFilters = Boolean(
    searchFilters.scene
    || searchFilters.preferChinese
    || searchFilters.noApiKey
    || searchFilters.sort !== 'score'
    || (searchProviders.length > 0 && selectedSearchProviderIds.length !== searchProviders.length)
  )
  const incompleteProviderNames = lastSearchIncompleteProviderIds.map((providerId) =>
    searchProviders.find(({ id }) => id === providerId)?.label || providerId
  )

  const installedPackageGroups = useMemo(() => installed
    .filter((skill) => skill.kind === 'expert-package-orchestrator')
    .map((packageSkill) => {
      const packageSlug = packageSkill.source.slice('skillhub-package:'.length)
      return {
        packageSkill,
        children: installed.filter((skill) => skill.scope === packageSkill.scope && skill.packageSlug === packageSlug),
      }
    }), [installed])
  const standaloneInstalledSkills = useMemo(() => installed.filter(
    (skill) => skill.kind !== 'expert-package-orchestrator' && !skill.packageSlug,
  ), [installed])
  const normalizedInstalledSearch = installedSearchInput.trim().toLowerCase()
  const installedSkillMatchesSearch = useCallback((skill: InstalledSkill) => {
    if (!normalizedInstalledSearch) return true
    return [
      skill.name,
      skill.description,
      skill.source,
      skill.scope,
      skill.kind,
      skill.packageCatalog?.displayName,
      skill.packageCatalog?.summary,
      skill.packageCatalog?.scene,
      skill.packageCatalog?.subScene,
    ]
      .some((value) => value?.toLowerCase().includes(normalizedInstalledSearch))
  }, [normalizedInstalledSearch])
  const filteredInstalledPackageGroups = useMemo(() => installedPackageGroups.flatMap(({ packageSkill, children }) => {
    const packageMatches = installedSkillMatchesSearch(packageSkill)
    const matchingChildren = packageMatches ? children : children.filter(installedSkillMatchesSearch)
    return packageMatches || matchingChildren.length > 0 ? [{ packageSkill, children: matchingChildren }] : []
  }), [installedPackageGroups, installedSkillMatchesSearch])
  const filteredStandaloneInstalledSkills = useMemo(
    () => standaloneInstalledSkills.filter(installedSkillMatchesSearch),
    [standaloneInstalledSkills, installedSkillMatchesSearch],
  )
  const hasInstalledSearchResults = filteredInstalledPackageGroups.length > 0 || filteredStandaloneInstalledSkills.length > 0

  const tabs: { id: SkillTab; label: string; icon: typeof BookOpen }[] = [
    { id: 'installed', label: t('skills.installedTab'), icon: BookOpen },
    { id: 'search', label: t('skills.searchTab'), icon: Search },
    { id: 'expert-packages', label: t('skills.expertPackagesTab'), icon: Boxes },
    { id: 'enterprise-zone', label: t('skills.enterpriseZoneTab'), icon: Building2 },
  ]
  const canAddFromUrl = activeTab === 'installed' || activeTab === 'search'

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = tabs[nextIndex]
    setActiveTab(nextTab.id)
    const tabButtons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabButtons?.[nextIndex]?.focus()
  }

  return (
    <>
    <ModalPanel open={isOpen} onClose={onClose}>
      <div className="relative w-full h-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 h-14 flex-shrink-0 border-b border-border/50 bg-surface">
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
          <div className="flex items-center justify-between border-b border-border/50 flex-shrink-0 px-6 py-2 bg-surface">
            <div className="flex gap-1" role="tablist" aria-label={t('skills.sections')}>
              {tabs.map((tab, index) => {
                const Icon = tab.icon
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    role="tab"
                    id={`skills-tab-${tab.id}`}
                    aria-controls={`skills-panel-${tab.id}`}
                    aria-selected={activeTab === tab.id}
                    tabIndex={activeTab === tab.id ? 0 : -1}
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
              {canAddFromUrl && <button
                onClick={() => setShowUrlBox((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                title={t('skills.addFromUrl')}
              >
                <Link2 className="w-3 h-3" />
                {t('skills.addFromUrl')}
              </button>}
            </div>
          </div>

          {/* URL install box (toggled) */}
          {showUrlBox && canAddFromUrl && (
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
          <div className="flex-1 overflow-y-auto bg-bg p-4 md:p-5">
            {/* Installed tab */}
            {activeTab === 'installed' && (
              <div id="skills-panel-installed" role="tabpanel" aria-labelledby="skills-tab-installed" className="space-y-3">
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
                  <>
                    <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary">
                          {t('skills.installedCount', { count: installed.length })}
                        </h3>
                        <p className="mt-0.5 text-[11px] text-text-tertiary">{t('skills.installedDescription')}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="relative min-w-0 flex-1 sm:w-60 sm:flex-none">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                          <input
                            value={installedSearchInput}
                            onChange={(event) => setInstalledSearchInput(event.target.value)}
                            placeholder={t('skills.installedSearchPlaceholder')}
                            aria-label={t('skills.installedSearchLabel')}
                            className="h-9 w-full rounded-lg border border-border bg-white pl-8 pr-8 text-xs text-text-primary outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                          {installedSearchInput && (
                            <button
                              onClick={() => setInstalledSearchInput('')}
                              className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                              aria-label={t('skills.clearSearch')}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="flex h-9 shrink-0 rounded-lg border border-border bg-white p-1" aria-label={t('skills.installedViewMode')}>
                          <button
                            onClick={() => setInstalledViewMode('cards')}
                            aria-pressed={installedViewMode === 'cards'}
                            aria-label={t('skills.cardView')}
                            className={`flex w-7 items-center justify-center rounded ${installedViewMode === 'cards' ? 'bg-surface text-accent shadow-sm' : 'text-text-tertiary hover:text-text-primary'}`}
                          >
                            <Grid2X2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setInstalledViewMode('list')}
                            aria-pressed={installedViewMode === 'list'}
                            aria-label={t('skills.listView')}
                            className={`flex w-7 items-center justify-center rounded ${installedViewMode === 'list' ? 'bg-surface text-accent shadow-sm' : 'text-text-tertiary hover:text-text-primary'}`}
                          >
                            <List className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                    {!hasInstalledSearchResults ? (
                      <div className="rounded-xl border border-dashed border-border bg-white px-4 py-10 text-center text-sm text-text-secondary">
                        {t('skills.installedNoMatches')}
                      </div>
                    ) : (
                    <div className="space-y-3">
                      <div className={installedViewMode === 'cards' ? 'grid grid-cols-1 items-start gap-3 md:grid-cols-2' : 'space-y-2'}>
                      {filteredInstalledPackageGroups.map(({ packageSkill, children }) => {
                        const packageKey = `${packageSkill.name}-${packageSkill.scope}`
                        const childrenId = `package-skills-${packageKey}`
                        const childrenExpanded = Boolean(normalizedInstalledSearch) || expandedPackageKeys.has(packageKey)
                        return <section key={packageKey} className="overflow-hidden rounded-xl border border-border bg-white shadow-sm">
                          <InstalledSkillCard
                            skill={packageSkill}
                            isSaving={isSaving || packageAction !== null}
                            updating={updatingSkillName === packageSkill.name || packageAction?.slug === packageSkill.name}
                            recentlyUpdated={recentlyUpdatedName === packageSkill.name}
                            showUpdateError={failedUpdateSkillName === packageSkill.name && !!updateError}
                            updateError={updateError}
                            confirmUninstall={confirmUninstall === `${packageSkill.name}-${packageSkill.scope}`}
                            isLast={children.length === 0 || !childrenExpanded}
                            rowClassName={`bg-accent/5 ${installedViewMode === 'cards' ? 'min-h-20' : ''}`}
                            childCount={children.length}
                            childrenExpanded={childrenExpanded}
                            childrenId={childrenId}
                            onToggleChildren={() => setExpandedPackageKeys((current) => {
                              const next = new Set(current)
                              if (next.has(packageKey)) next.delete(packageKey)
                              else next.add(packageKey)
                              return next
                            })}
                            onConfirmUninstall={() => setConfirmUninstall(`${packageSkill.name}-${packageSkill.scope}`)}
                            onCancelUninstall={() => setConfirmUninstall(null)}
                            onUninstall={() => void runPackageAction(packageSkill, 'uninstall')}
                            onUpdate={() => void runPackageAction(packageSkill, 'update')}
                            onClearUpdateError={clearUpdateError}
                            t={t}
                          />
                          {children.length > 0 && (
                    <div id={childrenId} hidden={!childrenExpanded} className="bg-white">
                              <div className="border-b border-border/70 px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                                {t('skills.expertPackages.includedSkills', { count: children.length })}
                              </div>
                              {children.map((skill, index) => (
                                <InstalledSkillCard
                                  key={`${skill.name}-${skill.scope}`}
                                  skill={skill}
                                  isSaving={isSaving || packageAction !== null}
                                  updating={updatingSkillName === skill.name}
                                  recentlyUpdated={recentlyUpdatedName === skill.name}
                                  showUpdateError={failedUpdateSkillName === skill.name && !!updateError}
                                  updateError={updateError}
                                  confirmUninstall={confirmUninstall === `${skill.name}-${skill.scope}`}
                                  isLast={index === children.length - 1}
                                  onConfirmUninstall={() => setConfirmUninstall(`${skill.name}-${skill.scope}`)}
                                  onCancelUninstall={() => setConfirmUninstall(null)}
                                  onUninstall={() => void handleUninstall(skill)}
                                  onUpdate={() => void handleUpdate(skill)}
                                  onClearUpdateError={clearUpdateError}
                                  t={t}
                                />
                              ))}
                            </div>
                          )}
                        </section>
                      })}
                      {filteredStandaloneInstalledSkills.length > 0 && (
                          filteredStandaloneInstalledSkills.map((skill) => (
                            <div
                              key={`${skill.name}-${skill.scope}`}
                              className="overflow-hidden rounded-xl border border-border bg-white shadow-sm"
                            >
                            <InstalledSkillCard
                              skill={skill}
                              isSaving={isSaving || packageAction !== null}
                              updating={updatingSkillName === skill.name}
                              recentlyUpdated={recentlyUpdatedName === skill.name}
                              showUpdateError={failedUpdateSkillName === skill.name && !!updateError}
                              updateError={updateError}
                              confirmUninstall={confirmUninstall === `${skill.name}-${skill.scope}`}
                              isLast
                              rowClassName={installedViewMode === 'cards' ? 'min-h-20' : undefined}
                              onConfirmUninstall={() => setConfirmUninstall(`${skill.name}-${skill.scope}`)}
                              onCancelUninstall={() => setConfirmUninstall(null)}
                              onUninstall={() => void handleUninstall(skill)}
                              onUpdate={() => void handleUpdate(skill)}
                              onClearUpdateError={clearUpdateError}
                              t={t}
                            />
                            </div>
                          )))}
                      </div>
                    </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Search tab */}
            {activeTab === 'search' && (
              <div id="skills-panel-search" role="tabpanel" aria-labelledby="skills-tab-search" className="space-y-3">
                <section className="rounded-xl border border-border bg-surface p-3 shadow-sm">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
                    <input
                      value={searchInput}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      placeholder={t('skills.searchPlaceholder')}
                      aria-label={t('skills.searchHeading')}
                      className="h-11 w-full rounded-xl border border-border bg-bg pl-10 pr-10 text-sm text-text-primary shadow-inner transition-colors placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                    />
                    {searchInput && (
                      <button
                        onClick={clearSearch}
                        className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                        aria-label={t('skills.clearSearch')}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:items-center">
                      <SkillProviderFilter onSelectionChange={handleProviderSelectionChange} />
                      <label className="relative min-w-0 flex-1 lg:max-w-56">
                        <span className="sr-only">{t('skills.sceneLabel')}</span>
                        <select
                          value={searchFilters.scene || ''}
                          onChange={(event) => updateSearchFilters({
                            scene: event.target.value ? event.target.value as SkillScene : undefined,
                          })}
                          className="h-9 w-full appearance-none rounded-lg border border-border bg-bg px-2.5 pr-8 text-[11px] text-text-secondary transition-colors hover:border-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                        >
                          <option value="">{t('skills.allScenes')}</option>
                          <option value="ai-agent">{t('skills.sceneAiAgent')}</option>
                          <option value="office-efficiency">{t('skills.sceneOffice')}</option>
                          <option value="development">{t('skills.sceneDevelopment')}</option>
                          <option value="content-creation">{t('skills.sceneContent')}</option>
                          <option value="knowledge-management">{t('skills.sceneKnowledge')}</option>
                          <option value="professional">{t('skills.sceneProfessional')}</option>
                          <option value="design-media">{t('skills.sceneDesign')}</option>
                        </select>
                        <SlidersHorizontal className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                      </label>

                      <button
                        onClick={() => updateSearchFilters({ preferChinese: !searchFilters.preferChinese })}
                        aria-pressed={Boolean(searchFilters.preferChinese)}
                        className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/20 ${
                          searchFilters.preferChinese
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-border bg-bg text-text-secondary hover:border-text-tertiary'
                        }`}
                      >
                        <Languages className="h-3.5 w-3.5" />
                        {t('skills.preferChinese')}
                      </button>
                      <button
                        onClick={() => updateSearchFilters({ noApiKey: !searchFilters.noApiKey })}
                        aria-pressed={Boolean(searchFilters.noApiKey)}
                        className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/20 ${
                          searchFilters.noApiKey
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-border bg-bg text-text-secondary hover:border-text-tertiary'
                        }`}
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        {t('skills.noApiKey')}
                      </button>

                      <div className="flex h-9 rounded-lg border border-border bg-bg p-0.5 lg:ml-auto">
                        <ArrowDownUp className="my-auto ml-2 mr-1.5 h-3.5 w-3.5 text-text-tertiary" />
                        {(['score', 'downloads', 'newest'] as const).map((sort) => (
                          <button
                            key={sort}
                            onClick={() => updateSearchFilters({ sort })}
                            aria-pressed={searchFilters.sort === sort}
                            className={`rounded-md px-2 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 ${
                              searchFilters.sort === sort
                                ? 'bg-surface text-text-primary shadow-sm'
                                : 'text-text-tertiary hover:text-text-secondary'
                            }`}
                          >
                            {t(`skills.sort${sort[0].toUpperCase()}${sort.slice(1)}`)}
                          </button>
                        ))}
                      </div>
                      {hasActiveSearchFilters && (
                        <button
                          onClick={clearSearchFilters}
                          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                          aria-label={t('skills.clearFilters')}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                  </div>
                </section>

                {searchInput && searchProviderBlockReason === 'checking' && (
                  <div role="status" className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-xs text-text-secondary">
                    <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    {t('skills.checkingProvidersBeforeSearch')}
                  </div>
                )}

                {searchInput && searchProviderBlockReason === 'no-available' && (
                  <div role="status" className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs text-text-secondary">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <div>
                      <p className="font-medium text-text-primary">{t('skills.noAvailableProviders')}</p>
                      <p className="mt-0.5 text-text-tertiary">{t('skills.noAvailableProvidersHint')}</p>
                    </div>
                  </div>
                )}

                {searchInput && incompleteProviderNames.length > 0 && searchProviderBlockReason !== 'no-available' && (
                  <div role="status" className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs text-text-secondary">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                    {t('skills.partialResultsWarning', { providers: incompleteProviderNames.join(', ') })}
                  </div>
                )}

                {/* Searching indicator */}
                {isSearching && (
                  <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2" aria-label={t('skills.searching')}>
                    {[0, 1, 2, 3].map((index) => (
                      <div key={index} className="rounded-xl border border-border bg-surface p-4 animate-pulse">
                        <div className="h-4 w-2/5 rounded bg-surface-hover" />
                        <div className="mt-2 h-3 w-1/3 rounded bg-surface-hover" />
                        <div className="mt-4 h-3 w-full rounded bg-surface-hover" />
                        <div className="mt-2 h-3 w-4/5 rounded bg-surface-hover" />
                      </div>
                    ))}
                  </div>
                )}

                {/* Empty states */}
                {!isSearching && searchResults.length === 0 && searchProviderBlockReason === null && (
                  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 py-9 text-center space-y-2">
                    <Search className="w-8 h-8 text-text-tertiary" />
                    <div>
                      <p className="text-sm font-medium text-text-secondary">
                        {searchInput ? t('skills.noResults') : t('skills.startSearching')}
                      </p>
                      <p className="max-w-sm text-xs text-text-tertiary mt-1">
                        {searchInput ? t('skills.noResultsHint') : t('skills.searchHint')}
                      </p>
                    </div>
                    {searchInput && hasActiveSearchFilters && (
                      <button
                        onClick={clearSearchFilters}
                        className="rounded-lg border border-border bg-bg px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
                      >
                        {t('skills.clearFilters')}
                      </button>
                    )}
                  </div>
                )}

                {/* Results */}
                {!isSearching && searchResults.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <p className="text-xs font-medium text-text-secondary">
                        {t('skills.resultsCount', { count: searchResults.length })}
                      </p>
                      <p className="text-[11px] text-text-tertiary">{t('skills.resultsHint')}</p>
                    </div>
                    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                    {searchResults.map((skill) => {
                      const isInstalled = isSearchResultInstalled(skill.name)
                      return (
                        <div
                          key={skill.id}
                          className="group flex min-h-32 flex-col rounded-xl border border-border bg-white p-3.5 shadow-sm transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md motion-reduce:transform-none"
                        >
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                              <Sparkles className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <h3 className="truncate text-sm font-semibold text-text-primary">{skill.name}</h3>
                              <p className="mt-1 truncate text-[11px] text-text-tertiary">{skill.source}</p>
                            </div>
                          </div>
                          <p className="mt-2 line-clamp-2 min-h-7 text-xs leading-4 text-text-secondary">
                            {skill.description || t('skills.noDescription')}
                          </p>
                          <div className="mt-auto flex items-center justify-between gap-3 pt-3">
                            <div className="min-w-0">
                              <span className="inline-flex rounded-md bg-surface-hover px-2 py-1 text-[10px] font-medium text-text-secondary">
                                {t('skills.sourceFrom', { source: skill.sourceKind })}
                              </span>
                              <p className="mt-1 text-[10px] text-text-tertiary">
                                {t('skills.installsCount', { count: skill.installs })}
                              </p>
                            </div>
                            <button
                              onClick={() => openInstallFromSearch(skill)}
                              disabled={isSaving || isInstalled}
                              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-accent-foreground transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                              title={isInstalled ? t('skills.alreadyInstalled') : t('skills.install')}
                            >
                              {isInstalled ? (
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              ) : (
                                <Download className="w-3.5 h-3.5" />
                              )}
                              <span>{isInstalled ? t('skills.alreadyInstalled') : t('skills.install')}</span>
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div id="skills-panel-expert-packages" role="tabpanel" aria-labelledby="skills-tab-expert-packages" className={activeTab === 'expert-packages' ? 'block' : 'hidden'}>
              <ExpertPackagesView
                active={isOpen && activeTab === 'expert-packages'}
                isOpen={isOpen}
                workspaceId={workspaceId}
                onInstalled={() => void fetchInstalled(workspaceId)}
              />
            </div>
            <div id="skills-panel-enterprise-zone" role="tabpanel" aria-labelledby="skills-tab-enterprise-zone" className={activeTab === 'enterprise-zone' ? 'block' : 'hidden'}>
              <EnterpriseZoneView
                active={isOpen && activeTab === 'enterprise-zone'}
                isOpen={isOpen}
                workspaceId={workspaceId}
                onInstalled={() => void fetchInstalled(workspaceId)}
              />
            </div>
          </div>
        </div>
      </ModalPanel>

      {installModal.open && (
        <SkillInstallModal
          source={installModal.source}
          workspaceId={workspaceId}
          onClose={handleInstallModalClose}
          onInstalled={handleInstalled}
        />
      )}
    </>
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
  isLast: boolean
  onConfirmUninstall: () => void
  onCancelUninstall: () => void
  onUninstall: () => void
  onUpdate: () => void
  onClearUpdateError: () => void
  t: ReturnType<typeof useTranslation>['t']
  rowClassName?: string
  childCount?: number
  childrenExpanded?: boolean
  childrenId?: string
  onToggleChildren?: () => void
}

function InstalledSkillCard({
  skill,
  isSaving,
  updating,
  recentlyUpdated,
  showUpdateError,
  updateError,
  confirmUninstall,
  isLast,
  onConfirmUninstall,
  onCancelUninstall,
  onUninstall,
  onUpdate,
  onClearUpdateError,
  t,
  rowClassName,
  childCount,
  childrenExpanded,
  childrenId,
  onToggleChildren,
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
  const isExpertPackage = skill.kind === 'expert-package-orchestrator'
  const ItemIcon = isExpertPackage ? Boxes : Sparkles
  const displayName = isExpertPackage ? skill.packageCatalog?.displayName ?? skill.name : skill.name
  const description = isExpertPackage ? skill.packageCatalog?.summary ?? skill.description : skill.description

  return (
    <div className={!isLast ? 'border-b border-border/70' : undefined}>
      <div className={`flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-hover/40 ${rowClassName || ''}`}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <ItemIcon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${scope.color}`}>
              <ScopeIcon className="w-2.5 h-2.5" />
              {scope.label}
            </span>
            {skill.isLegacySymlink && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                {t('skills.legacySymlink')}
              </span>
            )}
            {isExpertPackage && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">
                {t('skills.expertPackageOrchestrator')}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-0.5 truncate text-[11px] text-text-secondary">{description}</p>
          )}
          <p className="mt-0.5 truncate text-[10px] text-text-tertiary">
            {t('skills.sourceLabel')}: {skill.source}
            {skill.updatedAt && ` · ${t('skills.updatedAt', { date: new Date(skill.updatedAt).toLocaleDateString() })}`}
          </p>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {isExpertPackage && childCount !== undefined && onToggleChildren && (
            <button
              onClick={onToggleChildren}
              aria-expanded={childrenExpanded}
              aria-controls={childrenId}
              aria-label={t('skills.expertPackages.includedSkills', { count: childCount })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${childrenExpanded ? '' : '-rotate-90'}`} />
            </button>
          )}
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
              className="flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {t('skills.retry')}
              </button>
            </div>
          ) : (
            <button
              onClick={onUpdate}
              disabled={isSaving || updating}
              className="flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('skills.update')}</span>
            </button>
          )}

          <button
            onClick={onConfirmUninstall}
            disabled={isSaving || updating}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            aria-label={t('skills.uninstall')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {confirmUninstall && (
        <div className="border-t border-border/50 bg-destructive/5 px-3.5 py-2.5">
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
