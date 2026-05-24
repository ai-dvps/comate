import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Sidebar from './components/Sidebar'
import WorkspaceTabs from './components/WorkspaceTabs'
import WorkspaceSwitcher from './components/WorkspaceSwitcher'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import FileDrawer from './components/FileDrawer'
import FilePanel from './components/FilePanel'
import HeaderToolbar from './components/HeaderToolbar'
import CreateWorkspaceModal from './components/CreateWorkspaceModal'
import { useWorkspaceStore } from './stores/workspace-store'
import { useTheme } from './hooks/use-theme'
import { useAppSettings } from './hooks/use-app-settings'
import { isMacOS } from './lib/platform'

export interface ViewedFile {
  path: string
  name: string
  content: string
}

function App() {
  const { t } = useTranslation('common')
  useTheme()
  useAppSettings()

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const fetchWorkspaces = useWorkspaceStore((s) => s.fetchWorkspaces)
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const [drawerFile, setDrawerFile] = useState<ViewedFile | null>(null)
  const [pinnedFile, setPinnedFile] = useState<ViewedFile | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [isMac, setIsMac] = useState(false)
  const [claudeCheck, setClaudeCheck] = useState<{ ok: boolean; checking: boolean; error?: string }>({
    ok: true,
    checking: true,
  })

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

  useEffect(() => {
    fetchWorkspaces()
    checkClaudeCli()
    isMacOS().then(setIsMac)
  }, [fetchWorkspaces])

  const handleFileClick = async (path: string, name: string) => {
    if (!activeWorkspaceId) return
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
      setDrawerFile(file)
    } catch (err) {
      console.error('Failed to load file:', err)
    }
  }

  const handleFileDoubleClick = (_path: string, name: string) => {
    // Placeholder for attach behavior (deferred per plan)
    console.log(`Double-clicked file: ${name} — attach to chat context (deferred)`)
  }

  const copyFileContent = (file: ViewedFile | null) => {
    if (file?.content) {
      navigator.clipboard.writeText(file.content)
    }
  }

  const handlePinDrawer = () => {
    if (drawerFile) {
      setPinnedFile(drawerFile)
      setDrawerFile(null)
    }
  }

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
    <div className="h-screen flex flex-col bg-bg text-text-primary text-sm">
      {/* Top Bar */}
      <header className="flex items-center h-11 flex-shrink-0 border-b border-border/50">
        <div className={`flex items-center gap-3 pr-4 ${isMac ? 'pl-20' : 'pl-4'}`}>
          <div data-tauri-drag-region className="flex items-center gap-2 mr-4 select-none flex-shrink-0" onMouseDown={handleDrag}>
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-[10px] font-bold text-white">
              C
            </div>
            <span className="font-medium text-text-primary hidden sm:block">Claude Code</span>
          </div>
          <div className="flex-shrink-0">
            <WorkspaceSwitcher />
          </div>
          <div className="min-w-0 overflow-hidden">
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
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          onFileClick={handleFileClick}
          onFileDoubleClick={handleFileDoubleClick}
        />

        {/* Optional pinned file panel */}
        <FilePanel
          file={pinnedFile}
          onClose={() => setPinnedFile(null)}
          onCopy={() => copyFileContent(pinnedFile)}
        />

        {/* Main Area — always ChatPanel */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {activeWorkspace ? (
            <ChatPanel workspaceId={activeWorkspace.id} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-text-secondary">{t('selectOrCreateWorkspace')}</p>
            </div>
          )}
        </main>
      </div>

      {/* File Drawer (overlay) */}
      <FileDrawer
        file={drawerFile}
        onClose={() => setDrawerFile(null)}
        onPin={handlePinDrawer}
        onCopy={() => copyFileContent(drawerFile)}
      />

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
