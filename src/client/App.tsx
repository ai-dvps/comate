import WorkspaceList from './components/WorkspaceList'
import WorkspaceTabs from './components/WorkspaceTabs'
import { useWorkspaceStore } from './stores/workspace-store'

function App() {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore()
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)

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
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        <WorkspaceList />

        {/* Main Area */}
        <main className="flex-1 flex items-center justify-center">
          {activeWorkspace ? (
            <div className="text-center">
              <h2 className="text-lg font-medium text-text-primary mb-2">{activeWorkspace.name}</h2>
              <p className="text-sm text-text-secondary">{activeWorkspace.folderPath}</p>
              {activeWorkspace.description && (
                <p className="text-xs text-text-tertiary mt-2">{activeWorkspace.description}</p>
              )}
            </div>
          ) : (
            <div className="text-center">
              <p className="text-text-secondary">Select or create a workspace to get started</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
