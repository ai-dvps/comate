import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AlertCircle, X } from 'lucide-react'
import Sidebar from './components/Sidebar'
import { useSidebarWidth } from './hooks/use-sidebar-width'
import { useResizableWidth } from './hooks/use-resizable-width'
import WorkspaceTabs from './components/WorkspaceTabs'
import WorkspaceSwitcher from './components/WorkspaceSwitcher'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import FilePanel, { ViewedFile } from './components/FilePanel'
import HeaderToolbar from './components/HeaderToolbar'
import CreateWorkspaceModal from './components/CreateWorkspaceModal'
import { useWorkspaceStore } from './stores/workspace-store'
import { useProviderStore } from './stores/provider-store'
import { useTheme } from './hooks/use-theme'
import { useAppSettings } from './hooks/use-app-settings'
import { fontSizeClass } from './lib/font-size'
import { isMacOS } from './lib/platform'
import { useBadgeSync } from './lib/use-badge-sync'
import { cn } from './components/ui/utils'

function App() {
  const { t } = useTranslation('common')
  useTheme()
  useBadgeSync()
  const { uiFontSize } = useAppSettings()

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const openWorkspaceIds = useWorkspaceStore((s) => s.openWorkspaceIds)
  const fetchWorkspaces = useWorkspaceStore((s) => s.fetchWorkspaces)
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const [openFiles, setOpenFiles] = useState<ViewedFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [isMac, setIsMac] = useState(false)
  const [claudeCheck, setClaudeCheck] = useState<{ ok: boolean; checking: boolean; error?: string }>({
    ok: true,
    checking: true,
  })
  const [providerCheck, setProviderCheck] = useState<{ ok: boolean; checking: boolean; error?: string }>({
    ok: true,
    checking: true,
  })
  const [providerToastDismissed, setProviderToastDismissed] = useState(false)

  const fetchProviders = useProviderStore((s) => s.fetchProviders)
  const detectProviders = useProviderStore((s) => s.detectProviders)

  const checkClaudeCli = async () => {
    try {
      const res = await fetch('/api/health/claude')
      if (!res.ok) {
        const data = await res.json()
        setClaudeCheck({ ok: false, checking: false, error: data.message || 'Claude CLI not available' })
        return
      }
      setClaudeCheck({ ok: true, checking: false })
    } catch {
      setClaudeCheck({ ok: false, checking: false, error: 'Claude CLI not available' })
    }
  }

  const initProviders = async () => {
    try {
      await fetchProviders()
      const currentProviders = useProviderStore.getState().providers
      if (currentProviders.length === 0) {
        await detectProviders()
        const afterDetect = useProviderStore.getState().providers
        if (afterDetect.length === 0) {
          setProviderCheck({ ok: false, checking: false, error: t('provider.noProviderConfigured') })
          return
        }
      }
      setProviderCheck({ ok: true, checking: false })
    } catch {
      setProviderCheck({ ok: false, checking: false, error: t('provider.noProviderConfigured') })
    }
  }

  useEffect(() => {
    fetchWorkspaces()
    checkClaudeCli()
    initProviders()
    isMacOS().then(setIsMac)
  }, [fetchWorkspaces])

  useEffect(() => {
    if (providerCheck.ok) {
      setProviderToastDismissed(false)
    }
  }, [providerCheck.ok])

  const handleFileClick = async (path: string, name: string) => {
    if (!activeWorkspaceId) return

    const existing = openFiles.find((f) => f.path === path)
    if (existing) {
      setActiveFilePath(path)
      return
    }

    try {
      const res = await fetch(
        `/api/workspaces/${activeWorkspaceId}/files/content?path=${encodeURIComponent(path)}`
      )
      if (!res.ok) throw new Error('Failed to load file')
      const data = await res.json()
      const file: ViewedFile = {
        path,
        name,
        content: data.isBinary ? '[Binary file]' : data.content,
      }
      setOpenFiles((prev) => [...prev, file])
      setActiveFilePath(path)
    } catch (err) {
      console.error('Failed to load file:', err)
    }
  }

  const handleFileDoubleClick = (_path: string, name: string) => {
    // Placeholder for attach behavior (deferred per plan)
    console.log(`Double-clicked file: ${name} — attach to chat context (deferred)`)
  }

  const handleCloseFile = (path: string) => {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path)
      if (activeFilePath === path && next.length > 0) {
        const closedIndex = prev.findIndex((f) => f.path === path)
        const nextIndex = Math.min(closedIndex, next.length - 1)
        setActiveFilePath(next[nextIndex].path)
      } else if (next.length === 0) {
        setActiveFilePath('')
      }
      return next
    })
  }

  const handleSelectFile = (path: string) => {
    setActiveFilePath(path)
  }

  const copyFileContent = () => {
    const file = openFiles.find((f) => f.path === activeFilePath)
    if (file?.content) {
      navigator.clipboard.writeText(file.content)
    }
  }

  useEffect(() => {
    setOpenFiles([])
    setActiveFilePath('')
  }, [activeWorkspaceId])

  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth()
  const { width: filePanelWidth, setWidth: setFilePanelWidth } = useResizableWidth({
    storageKey: 'file-panel-width',
    defaultWidth: 384,
    minWidth: 200,
  })

  const handleDrag = (e: React.MouseEvent) => {
    if (!isMac || e.button !== 0) return
    getCurrentWindow().startDragging().catch(() => {})
  }

  if (claudeCheck.checking) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg text-text-primary">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-sm font-bold text-white">
            C
          </div>
          <p className="text-text-secondary">Checking Claude CLI...</p>
        </div>
      </div>
    )
  }

  if (!claudeCheck.ok) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg text-text-primary p-8">
        <div className="max-w-md w-full bg-surface rounded-xl border border-border p-8 flex flex-col items-center gap-6 text-center">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-lg font-bold text-white">
            C
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-semibold">Claude CLI Required</h1>
            <p className="text-text-secondary text-sm">
              {claudeCheck.error || 'Claude CLI must be installed and authenticated.'}
            </p>
          </div>
          <button
            onClick={checkClaudeCli}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`h-screen flex flex-col bg-bg text-text-primary ${fontSizeClass(uiFontSize)} overflow-x-hidden`}>
      {/* Top Bar */}
      <header className="flex items-center h-11 flex-shrink-0 border-b border-border/50 relative z-30">
        <div className={`flex items-center gap-3 pr-4 ${isMac ? 'pl-20' : 'pl-4'} min-w-0`}>
          <div data-tauri-drag-region className="w-4 self-stretch select-none flex-shrink-0" onMouseDown={handleDrag} />
          <div className="flex-shrink-0">
            <WorkspaceSwitcher />
          </div>
          <div className="min-w-0">
            <WorkspaceTabs />
          </div>
        </div>
        <div data-tauri-drag-region className="flex-1 self-stretch select-none" onMouseDown={handleDrag} />
        <div className="flex items-center flex-shrink-0 pl-4 pr-4">
          <HeaderToolbar
            onCreateWorkspace={() => setShowCreateModal(true)}
            onOpenSettings={() => setShowSettings(true)}
          />
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Provider Error Toast */}
        {!providerCheck.ok && !providerCheck.checking && !providerToastDismissed && (
          <div className="absolute top-2 right-2 z-20 bg-surface border border-border rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 max-w-xs">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
            <span className="text-xs text-text-primary flex-1">{providerCheck.error}</span>
            <button
              onClick={() => setShowSettings(true)}
              className="px-2 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-md transition-colors flex-shrink-0"
            >
              {t('provider.configure')}
            </button>
            <button
              onClick={() => setProviderToastDismissed(true)}
              className="p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
              aria-label={t('close')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <Sidebar
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          onFileClick={handleFileClick}
          onFileDoubleClick={handleFileDoubleClick}
        />

        {/* File panel */}
        <FilePanel
          files={openFiles}
          activeFilePath={activeFilePath}
          width={filePanelWidth}
          onSelectFile={handleSelectFile}
          onCloseFile={handleCloseFile}
          onWidthChange={setFilePanelWidth}
          onCopy={copyFileContent}
        />

        {/* Main Area — keep all open workspace panels mounted */}
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {activeWorkspace ? (
            openWorkspaceIds.map((wsId) => (
              <div
                key={wsId}
                className={cn(
                  'absolute inset-0 flex flex-col',
                  wsId === activeWorkspaceId ? 'visible' : 'invisible pointer-events-none'
                )}
                aria-hidden={wsId !== activeWorkspaceId}
                {...(wsId !== activeWorkspaceId ? { inert: '' } : {})}
              >
                <ChatPanel workspaceId={wsId} />
              </div>
            ))
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-text-secondary">{t('selectOrCreateWorkspace')}</p>
            </div>
          )}
        </main>
      </div>

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
        />
      )}

      {showCreateModal && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  )
}

export default App
