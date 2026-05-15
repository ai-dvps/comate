import { useState } from 'react'
import Sidebar from './components/Sidebar'
import WorkspaceTabs from './components/WorkspaceTabs'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import { useWorkspaceStore } from './stores/workspace-store'
import { X, Copy, Settings } from 'lucide-react'

interface ViewedFile {
  path: string
  name: string
  content: string
}

function App() {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore()
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
  const [viewedFile, setViewedFile] = useState<ViewedFile | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const handleFileClick = async (path: string, name: string) => {
    if (!activeWorkspaceId) return
    try {
      const res = await fetch(`/api/workspaces/${activeWorkspaceId}/files/content?path=${encodeURIComponent(path)}`)
      if (!res.ok) throw new Error('Failed to load file')
      const data = await res.json()
      if (data.isBinary) {
        setViewedFile({ path, name, content: '[Binary file]' })
      } else {
        setViewedFile({ path, name, content: data.content })
      }
    } catch (err) {
      console.error('Failed to load file:', err)
    }
  }

  const copyFileContent = () => {
    if (viewedFile?.content) {
      navigator.clipboard.writeText(viewedFile.content)
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
        {activeWorkspace && (
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Workspace settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        )}
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar onFileClick={handleFileClick} />

        {/* Main Area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {viewedFile ? (
            <div className="flex flex-col h-full">
              {/* File Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 flex-shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-text-primary font-mono truncate">{viewedFile.name}</span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={copyFileContent}
                    className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
                    title="Copy content"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewedFile(null)}
                    className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
                    title="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {/* File Content */}
              <div className="flex-1 overflow-auto p-4">
                <pre className="text-[13px] font-mono leading-relaxed text-text-primary whitespace-pre-wrap">
                  {viewedFile.content}
                </pre>
              </div>
            </div>
          ) : activeWorkspace ? (
            <ChatPanel workspaceId={activeWorkspace.id} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-text-secondary">Select or create a workspace to get started</p>
            </div>
          )}
        </main>
      </div>
      {showSettings && activeWorkspaceId && (
        <SettingsPanel
          workspaceId={activeWorkspaceId}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

export default App