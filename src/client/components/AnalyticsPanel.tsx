/**
 * AnalyticsPanel — modal shell hosting the Global and Workspace dashboards.
 *
 * Mirrors the SettingsPanel chrome (R1): a header entry point toggles a
 * fixed overlay with a centered card, a row of internal tabs (Global /
 * Workspace, R2), and a content area that mounts the right view. The
 * active tab is persisted to localStorage so reopening the modal lands on
 * the last-used tab (origin F1).
 *
 * The panel is a thin shell — fetching, loading, and error state live in
 * the analytics store (U3); the views themselves are presentational (U5).
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, RefreshCw, X } from 'lucide-react'

import { AnalyticsEmptyState, GlobalStatsView, WorkspaceSelector, WorkspaceStatsView } from './analytics/index.js'
import { useAnalyticsStore } from '../stores/analytics-store.js'
import { useWorkspaceStore } from '../stores/workspace-store.js'

const TAB_STORAGE_KEY = 'comate.analytics.activeTab'
type AnalyticsTab = 'global' | 'workspace'

interface AnalyticsPanelProps {
  onClose: () => void
}

function readInitialTab(): AnalyticsTab {
  try {
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY)
    if (stored === 'global' || stored === 'workspace') return stored
  } catch {
    // localStorage may be unavailable (private mode); fall through to default.
  }
  return 'global'
}

export default function AnalyticsPanel({ onClose }: AnalyticsPanelProps) {
  const { t } = useTranslation('analytics')

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceIdFromStore = useWorkspaceStore((s) => s.activeWorkspaceId)

  const globalSummary = useAnalyticsStore((s) => s.globalSummary)
  const workspaceSummaries = useAnalyticsStore((s) => s.workspaceSummaries)
  const activeWorkspaceId = useAnalyticsStore((s) => s.activeWorkspaceId)
  const isLoadingGlobal = useAnalyticsStore((s) => s.isLoadingGlobal)
  const isLoadingWorkspace = useAnalyticsStore((s) => s.isLoadingWorkspace)
  const globalError = useAnalyticsStore((s) => s.globalError)
  const workspaceError = useAnalyticsStore((s) => s.workspaceError)
  const fetchGlobalSummary = useAnalyticsStore((s) => s.fetchGlobalSummary)
  const fetchWorkspaceSummary = useAnalyticsStore((s) => s.fetchWorkspaceSummary)
  const setActiveWorkspace = useAnalyticsStore((s) => s.setActiveWorkspace)

  const [activeTab, setActiveTab] = useState<AnalyticsTab>(readInitialTab)

  // Persist tab choice.
  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, activeTab)
    } catch {
      // Swallow storage failures — non-critical.
    }
  }, [activeTab])

  // Trigger a global fetch on first open (the store is idempotent if data is
  // already fresh; user can still hit the refresh button to force re-fetch).
  useEffect(() => {
    if (!globalSummary && !isLoadingGlobal && !globalError) {
      void fetchGlobalSummary()
    }
  }, [globalSummary, isLoadingGlobal, globalError, fetchGlobalSummary])

  // Default the Workspace tab's selector to the chat-active workspace on
  // first open if the user hasn't picked one yet.
  useEffect(() => {
    if (activeTab === 'workspace' && !activeWorkspaceId && activeWorkspaceIdFromStore) {
      setActiveWorkspace(activeWorkspaceIdFromStore)
    }
  }, [activeTab, activeWorkspaceId, activeWorkspaceIdFromStore, setActiveWorkspace])

  // Esc closes the modal (matches SettingsPanel behavior).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleRefresh = () => {
    if (activeTab === 'global') {
      void fetchGlobalSummary()
    } else if (activeWorkspaceId) {
      void fetchWorkspaceSummary(activeWorkspaceId)
    }
  }

  const tabs: { id: AnalyticsTab; label: string }[] = [
    { id: 'global', label: t('titleGlobal') },
    { id: 'workspace', label: t('titleWorkspace') },
  ]

  const selectedWorkspaceSummary = activeWorkspaceId
    ? workspaceSummaries[activeWorkspaceId] ?? null
    : null

  return (
    <div className="fixed top-11 inset-x-0 bottom-0 z-50 flex flex-col">
      {/* Modal area */}
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 relative">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={onClose} />

        {/* Card */}
        <div className="relative w-full h-full max-h-[90vh] max-w-[90vw] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 h-14 flex-shrink-0 border-b border-border/50">
            <div className="flex items-center gap-2 min-w-0">
              <BarChart3 className="w-4 h-4 text-text-tertiary shrink-0" />
              <h2 className="text-sm font-medium text-text-primary truncate">{t('title')}</h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleRefresh}
                disabled={activeTab === 'global' ? isLoadingGlobal : isLoadingWorkspace}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-50"
                title={t('refresh')}
              >
                <RefreshCw className={`w-4 h-4 ${(activeTab === 'global' ? isLoadingGlobal : isLoadingWorkspace) ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border/50 flex-shrink-0 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-3 px-4 text-[11px] font-medium transition-all ${
                  activeTab === tab.id
                    ? 'text-text-primary border-b-2 border-accent'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
            {activeTab === 'global' && (
              <GlobalTabContent
                summary={globalSummary}
                isLoading={isLoadingGlobal}
                error={globalError}
                onRetry={fetchGlobalSummary}
              />
            )}

            {activeTab === 'workspace' && (
              <WorkspaceTabContent
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                onSelectWorkspace={setActiveWorkspace}
                summary={selectedWorkspaceSummary}
                isLoading={isLoadingWorkspace}
                error={workspaceError}
                onRetry={() => {
                  if (activeWorkspaceId) void fetchWorkspaceSummary(activeWorkspaceId)
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface GlobalTabContentProps {
  summary: ReturnType<typeof useAnalyticsStore.getState>['globalSummary']
  isLoading: boolean
  error: string | null
  onRetry: () => void
}

function GlobalTabContent({ summary, isLoading, error, onRetry }: GlobalTabContentProps) {
  const { t } = useTranslation('analytics')
  if (isLoading && !summary) {
    return <AnalyticsEmptyState variant="loading" />
  }
  if (error && !summary) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <AnalyticsEmptyState variant="error" message={error} />
        <button
          onClick={onRetry}
          className="px-3 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
        >
          {t('retry')}
        </button>
      </div>
    )
  }
  if (!summary || summary.totalSessions === 0) {
    return <AnalyticsEmptyState variant="empty" />
  }
  return <GlobalStatsView summary={summary} />
}

interface WorkspaceTabContentProps {
  workspaces: ReturnType<typeof useWorkspaceStore.getState>['workspaces']
  activeWorkspaceId: string | null
  onSelectWorkspace: (id: string | null) => void
  summary: ReturnType<typeof useAnalyticsStore.getState>['workspaceSummaries'][string] | null
  isLoading: boolean
  error: string | null
  onRetry: () => void
}

function WorkspaceTabContent({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  summary,
  isLoading,
  error,
  onRetry,
}: WorkspaceTabContentProps) {
  const { t } = useTranslation('analytics')

  if (workspaces.length === 0) {
    return <AnalyticsEmptyState variant="empty" />
  }

  return (
    <div className="flex flex-col h-full">
      {/* Workspace selector bar */}
      <div className="px-3 md:px-6 py-3 border-b border-border/40 flex-shrink-0">
        <WorkspaceSelector
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={(id) => onSelectWorkspace(id)}
          disabled={isLoading}
        />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        {!activeWorkspaceId ? (
          <AnalyticsEmptyState variant="empty" />
        ) : isLoading && !summary ? (
          <AnalyticsEmptyState variant="loading" />
        ) : error && !summary ? (
          <AnalyticsEmptyState variant="error" message={error} />
        ) : !summary || summary.totalSessions === 0 ? (
          <AnalyticsEmptyState variant="empty" />
        ) : (
          <WorkspaceStatsView summary={summary} />
        )}
        {error && summary && (
          <div className="px-3 md:px-6 py-2 text-[11px] text-destructive border-t border-border/40">
            {error}{' '}
            <button onClick={onRetry} className="underline hover:no-underline">
              {t('retry')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
