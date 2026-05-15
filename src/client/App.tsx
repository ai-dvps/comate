import { useState } from 'react'
import Sidebar from './components/Sidebar'
import WorkspaceTabs from './components/WorkspaceTabs'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import FileDrawer from './components/FileDrawer'
import FilePanel from './components/FilePanel'
import HeaderToolbar from './components/HeaderToolbar'
import CreateWorkspaceModal from './components/CreateWorkspaceModal'
import { useWorkspaceStore } from './stores/workspace-store'

export interface ViewedFile {
  path: string
  name: string
  content: string
}

function App() {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore()
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const [drawerFile, setDrawerFile] = useState<ViewedFile | null>(null)
  const [pinnedFile, setPinnedFile] = useState<ViewedFile | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)

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

  return (
    <div className="h-screen flex flex-col bg-bg text-text-primary text-sm">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-4 h-12 flex-shrink-0 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 mr-4">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-[10px] font-bold text-white">
              C
            </div>
            <span className="font-medium text-text-primary hidden sm:block">Claude Code</span>
          </div>
          <WorkspaceTabs />
        </div>
        <HeaderToolbar
          onCreateWorkspace={() => setShowCreateModal(true)}
          onOpenSettings={() => setShowSettings(true)}
          canOpenSettings={!!activeWorkspace}
        />
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
              <p className="text-text-secondary">Select or create a workspace to get started</p>
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

      {showSettings && activeWorkspaceId && (
        <SettingsPanel
          workspaceId={activeWorkspaceId}
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
