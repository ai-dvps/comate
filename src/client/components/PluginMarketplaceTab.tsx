import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  X,
  Store,
  Download,
  Globe,
  FolderOpen,
  User,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  LayoutGrid,
  CheckCircle2,
  Tag,
  FilterX,
} from 'lucide-react'
import { usePluginStore } from '../stores/plugin-store'
import ScopePickerModal from './ScopePickerModal'

type MarketplaceFilter = 'all' | 'available' | 'installed'

interface PluginMarketplaceTabProps {
  workspaceId: string
}

const PLUGINS_PER_SECTION = 8

interface ModalState {
  open: boolean
  pluginId: string
  pluginName: string
  sourceUrl: string
}

const ScopeBadge = ({ scope }: { scope: import('../stores/plugin-store').PluginScope }) => {
  const { t } = useTranslation('settings')
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

export default function PluginMarketplaceTab({ workspaceId }: PluginMarketplaceTabProps) {
  const { t } = useTranslation('settings')
  const [marketplaceFilter, setMarketplaceFilter] = useState<MarketplaceFilter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [showDirectInstall, setShowDirectInstall] = useState(false)
  const [directUrl, setDirectUrl] = useState('')
  const [modal, setModal] = useState<ModalState>({
    open: false,
    pluginId: '',
    pluginName: '',
    sourceUrl: '',
  })
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    installedPlugins,
    marketplacePlugins,
    isLoading,
    isSaving,
    marketplaceQuery,
    selectedMarketplaces,
    selectedKeywords,
    expandedSections,
    fetchMarketplacePlugins,
    uninstallPlugin,
    fetchInstalledPlugins,
    setMarketplaceQuery,
    toggleMarketplaceFilter,
    clearMarketplaceFilters,
    toggleKeywordFilter,
    toggleSection,
    resetFilters,
  } = usePluginStore()

  // Initialize search input from store query
  useEffect(() => {
    setSearchInput(marketplaceQuery)
  }, [marketplaceQuery])

  // Fetch marketplace on mount
  useEffect(() => {
    fetchMarketplacePlugins(marketplaceQuery)
  }, [fetchMarketplacePlugins, marketplaceQuery])

  // Debounced search
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(() => {
        setMarketplaceQuery(value)
        fetchMarketplacePlugins(value)
      }, 300)
    },
    [setMarketplaceQuery, fetchMarketplacePlugins]
  )

  const clearSearch = useCallback(() => {
    setSearchInput('')
    setMarketplaceQuery('')
    fetchMarketplacePlugins('')
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
  }, [setMarketplaceQuery, fetchMarketplacePlugins])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [])

  // Helper: get installed scopes for a plugin
  const getInstalledScopes = useCallback(
    (pluginId: string) => {
      return installedPlugins.filter((p) => p.id === pluginId).map((p) => p.scope)
    },
    [installedPlugins]
  )

  const handleInstall = (pluginId: string, pluginName: string, sourceUrl: string) => {
    const installed = installedPlugins.some((p) => p.id === pluginId)
    if (installed) return
    setModal({ open: true, pluginId, pluginName, sourceUrl })
  }

  const handleUninstall = async (pluginId: string) => {
    const target = installedPlugins.find((p) => p.id === pluginId)
    if (!target) return
    const ok = await uninstallPlugin(pluginId, target.scope, workspaceId, true)
    if (ok) {
      await fetchInstalledPlugins(workspaceId)
    }
  }

  const handleDirectInstall = () => {
    if (!directUrl.trim()) return
    const pluginId = directUrl.split('/').pop()?.replace('.git', '') || 'direct-plugin'
    setModal({ open: true, pluginId, pluginName: pluginId, sourceUrl: directUrl.trim() })
  }

  const handleModalSuccess = async () => {
    setModal((m) => ({ ...m, open: false }))
    await fetchInstalledPlugins(workspaceId)
  }

  // Compute all unique marketplace sources
  const marketplaceSources = useMemo(() => {
    const sources = new Map<string, { count: number; builtIn: boolean }>()
    marketplacePlugins.forEach((p) => {
      const name = p.sourceMarketplace || t('plugins.unknownMarketplace')
      const existing = sources.get(name)
      sources.set(name, {
        count: (existing?.count || 0) + 1,
        builtIn: existing?.builtIn || !!p.builtIn,
      })
    })
    return Array.from(sources.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [marketplacePlugins, t])

  // Compute all unique keywords
  const allKeywords = useMemo(() => {
    const counts = new Map<string, number>()
    marketplacePlugins.forEach((p) => {
      p.keywords?.forEach((k) => {
        counts.set(k, (counts.get(k) || 0) + 1)
      })
    })
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([k]) => k)
  }, [marketplacePlugins])

  // Apply all filters
  const filteredPlugins = useMemo(() => {
    let plugins = marketplacePlugins

    // Marketplace source filter
    if (selectedMarketplaces.length > 0) {
      plugins = plugins.filter((p) => selectedMarketplaces.includes(p.sourceMarketplace || ''))
    }

    // Keyword filter
    if (selectedKeywords.length > 0) {
      plugins = plugins.filter((p) => p.keywords?.some((k) => selectedKeywords.includes(k)))
    }

    // Installed/available filter
    if (marketplaceFilter === 'available') {
      plugins = plugins.filter((p) => getInstalledScopes(p.id).length === 0)
    } else if (marketplaceFilter === 'installed') {
      plugins = plugins.filter((p) => getInstalledScopes(p.id).length > 0)
    }

    return plugins
  }, [marketplacePlugins, selectedMarketplaces, selectedKeywords, marketplaceFilter, getInstalledScopes])

  // Group by marketplace; pin built-in marketplaces to the top so they stay visible
  const groupedPlugins = useMemo(() => {
    const groups: Record<string, typeof filteredPlugins> = {}
    filteredPlugins.forEach((plugin) => {
      const key = plugin.sourceMarketplace || t('plugins.unknownMarketplace')
      if (!groups[key]) groups[key] = []
      groups[key].push(plugin)
    })
    return Object.entries(groups).sort((a, b) => {
      const aBuiltIn = a[1].some((p) => p.builtIn) ? 1 : 0
      const bBuiltIn = b[1].some((p) => p.builtIn) ? 1 : 0
      if (aBuiltIn !== bBuiltIn) return bBuiltIn - aBuiltIn
      return b[1].length - a[1].length
    })
  }, [filteredPlugins, t])

  const totalPlugins = filteredPlugins.length
  const totalMarketplaces = groupedPlugins.length
  const hasActiveFilters =
    selectedMarketplaces.length > 0 ||
    selectedKeywords.length > 0 ||
    marketplaceFilter !== 'all' ||
    marketplaceQuery !== ''

  const filterButtons: { id: MarketplaceFilter; label: string; icon: typeof LayoutGrid }[] = [
    { id: 'all', label: t('plugins.filterAll'), icon: LayoutGrid },
    { id: 'available', label: t('plugins.filterAvailable'), icon: Download },
    { id: 'installed', label: t('plugins.filterInstalled'), icon: CheckCircle2 },
  ]

  return (
    <div className="space-y-4">
      {/* Search + Direct install toggle */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t('plugins.searchPlaceholder')}
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
        <button
          onClick={() => setShowDirectInstall(!showDirectInstall)}
          className="px-3 py-2 text-xs font-medium bg-surface-hover hover:bg-surface-active text-text-secondary rounded-lg transition-colors"
        >
          {t('plugins.directInstall')}
        </button>
      </div>

      {/* Direct install form */}
      {showDirectInstall && (
        <div className="flex gap-2 bg-bg border border-border rounded-xl p-3">
          <input
            value={directUrl}
            onChange={(e) => setDirectUrl(e.target.value)}
            placeholder={t('plugins.directUrlPlaceholder')}
            className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <button
            onClick={handleDirectInstall}
            disabled={!directUrl.trim() || isSaving}
            className="px-3 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Marketplace source chips */}
      {marketplaceSources.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
            {t('plugins.marketplacesTitle')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                if (selectedMarketplaces.length > 0) {
                  // Reset only marketplace filter, keep others
                  clearMarketplaceFilters()
                }
              }}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                selectedMarketplaces.length === 0
                  ? 'bg-accent/10 text-accent'
                  : 'bg-surface-hover text-text-secondary hover:text-text-primary hover:bg-surface-active'
              }`}
            >
              {t('plugins.allMarketplaces')}
            </button>
            {marketplaceSources.map(([name, { count, builtIn }]) => {
              const isActive = selectedMarketplaces.includes(name)
              return (
                <button
                  key={name}
                  onClick={() => toggleMarketplaceFilter(name)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    isActive
                      ? 'bg-accent/10 text-accent'
                      : 'bg-surface-hover text-text-secondary hover:text-text-primary hover:bg-surface-active'
                  }`}
                >
                  <Store className="w-3 h-3" />
                  {name}
                  {builtIn && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-accent/10 text-accent">
                      {t('plugins.builtIn')}
                    </span>
                  )}
                  <span className="text-text-tertiary">({count})</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Keyword chips */}
      {allKeywords.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
            {t('plugins.keywordsTitle')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allKeywords.map((keyword) => {
              const isActive = selectedKeywords.includes(keyword)
              return (
                <button
                  key={keyword}
                  onClick={() => toggleKeywordFilter(keyword)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    isActive
                      ? 'bg-accent/10 text-accent'
                      : 'bg-surface-hover text-text-secondary hover:text-text-primary hover:bg-surface-active'
                  }`}
                >
                  <Tag className="w-3 h-3" />
                  {keyword}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Filter buttons + result count */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-1">
          {filterButtons.map((filter) => {
            const Icon = filter.icon
            return (
              <button
                key={filter.id}
                onClick={() => setMarketplaceFilter(filter.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                  marketplaceFilter === filter.id
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {filter.label}
              </button>
            )
          })}
        </div>
        <span className="text-[11px] text-text-tertiary whitespace-nowrap">
          {t('plugins.pluginsFound', {
            count: totalPlugins,
            marketplaces: totalMarketplaces,
          })}
        </span>
      </div>

      {/* Clear filters */}
      {hasActiveFilters && (
        <button
          onClick={() => {
            resetFilters()
            setMarketplaceFilter('all')
            fetchMarketplacePlugins('')
          }}
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent-hover transition-colors"
        >
          <FilterX className="w-3 h-3" />
          {t('plugins.clearFilters')}
        </button>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 text-text-tertiary animate-spin" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && totalPlugins === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
          <Store className="w-8 h-8 text-text-tertiary" />
          <div>
            <p className="text-sm font-medium text-text-secondary">
              {marketplaceFilter === 'installed'
                ? t('plugins.noInstalledMarketplace')
                : marketplaceFilter === 'available'
                  ? t('plugins.noAvailableMarketplace')
                  : t('plugins.noMarketplace')}
            </p>
            <p className="text-xs text-text-tertiary mt-1">{t('plugins.trySearchHint')}</p>
          </div>
          {hasActiveFilters && (
            <button
              onClick={() => {
                resetFilters()
                setMarketplaceFilter('all')
                fetchMarketplacePlugins('')
              }}
              className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
            >
              {t('plugins.clearFilters')}
            </button>
          )}
        </div>
      )}

      {/* Plugin grid grouped by marketplace */}
      {!isLoading && totalPlugins > 0 && (
        <div className="space-y-6">
          {groupedPlugins.map(([marketplaceName, plugins]) => {
            const isExpanded = expandedSections[marketplaceName] ?? plugins.length <= PLUGINS_PER_SECTION
            const displayedPlugins = isExpanded
              ? plugins
              : plugins.slice(0, PLUGINS_PER_SECTION)
            const hasMore = plugins.length > PLUGINS_PER_SECTION
            const isBuiltIn = plugins.some((p) => p.builtIn)

            return (
              <div key={marketplaceName}>
                <button
                  onClick={() => toggleSection(marketplaceName)}
                  className="w-full flex items-center gap-2 mb-3 group"
                >
                  <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider flex items-center gap-2">
                    <Store className="w-3.5 h-3.5" />
                    {marketplaceName}
                    {isBuiltIn && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent normal-case">
                        {t('plugins.builtIn')}
                      </span>
                    )}
                    <span className="text-[10px] font-normal text-text-tertiary normal-case">
                      ({plugins.length})
                    </span>
                  </h3>
                  <span className="ml-auto text-text-tertiary group-hover:text-text-secondary transition-colors">
                    {isExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </span>
                </button>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {displayedPlugins.map((plugin) => {
                    const installedScopes = getInstalledScopes(plugin.id)
                    const isUserInstalled = installedScopes.includes('user')
                    const isProjectInstalled = installedScopes.includes('project')
                    const isLocalInstalled = installedScopes.includes('local')

                    return (
                      <div
                        key={plugin.id}
                        className="bg-bg border border-border rounded-xl p-4 hover:border-accent/30 transition-colors"
                        style={{ contentVisibility: 'auto' }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-sm font-medium text-text-primary truncate">
                                {plugin.displayName || plugin.name}
                              </h3>
                              {isUserInstalled && <ScopeBadge scope="user" />}
                              {isProjectInstalled && <ScopeBadge scope="project" />}
                              {isLocalInstalled && <ScopeBadge scope="local" />}
                            </div>
                            <p className="text-[11px] text-text-tertiary mt-0.5">
                              {plugin.id}@{plugin.version}
                              {plugin.author && ` · ${plugin.author}`}
                            </p>
                          </div>
                          {installedScopes.length > 0 ? (
                            <button
                              onClick={() => handleUninstall(plugin.id)}
                              disabled={isSaving}
                              className="px-3 py-1.5 text-[11px] font-medium bg-surface-hover hover:bg-destructive/10 text-text-secondary hover:text-destructive rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
                            >
                              {t('plugins.uninstall')}
                            </button>
                          ) : (
                            <button
                              onClick={() =>
                                handleInstall(
                                  plugin.id,
                                  plugin.displayName || plugin.name,
                                  plugin.sourceUrl || `https://code.claude.com/plugins/${plugin.id}`
                                )
                              }
                              disabled={isSaving}
                              className="px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
                            >
                              {t('plugins.install')}
                            </button>
                          )}
                        </div>
                        {plugin.description && (
                          <p className="text-[11px] text-text-secondary mt-2 line-clamp-2">
                            {plugin.description}
                          </p>
                        )}
                        {plugin.keywords && plugin.keywords.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
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
                      </div>
                    )
                  })}
                </div>

                {hasMore && (
                  <button
                    onClick={() => toggleSection(marketplaceName)}
                    className="mt-3 w-full py-2 text-[11px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                  >
                    {isExpanded
                      ? t('plugins.showLess')
                      : t('plugins.showAll', { count: plugins.length - PLUGINS_PER_SECTION })}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ScopePickerModal
        pluginId={modal.pluginId}
        pluginName={modal.pluginName}
        sourceUrl={modal.sourceUrl}
        isOpen={modal.open}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
        onSuccess={handleModalSuccess}
        workspaceId={workspaceId}
      />
    </div>
  )
}
