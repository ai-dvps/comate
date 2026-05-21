import { useState, useEffect } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useTheme } from '../hooks/use-theme'
import { X, Eye, EyeOff, Plus, Trash2, Save, Sun, Moon, Monitor } from 'lucide-react'

interface SettingsPanelProps {
  workspaceId: string
  onClose: () => void
}

type SettingsTab = 'general' | 'settings' | 'skills' | 'mcp' | 'hooks'

export default function SettingsPanel({ workspaceId, onClose }: SettingsPanelProps) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [skills, setSkills] = useState<{ name: string }[]>([])
  const [mcpServers, setMcpServers] = useState<{ name: string; command: string; args: string }[]>([])
  const [hooks, setHooks] = useState<{ name: string; scriptPath: string }[]>([])

  // New item inputs
  const [newSkill, setNewSkill] = useState('')
  const [newMcpName, setNewMcpName] = useState('')
  const [newMcpCommand, setNewMcpCommand] = useState('')
  const [newMcpArgs, setNewMcpArgs] = useState('')
  const [newHookName, setNewHookName] = useState('')
  const [newHookPath, setNewHookPath] = useState('')

  useEffect(() => {
    if (workspace) {
      setName(workspace.name)
      setDescription(workspace.description)
      setModel((workspace.settings?.model as string) || '')
      setApiKey((workspace.settings?.apiKey as string) || '')
      setSkills([...workspace.skills])
      setMcpServers(
        workspace.mcpServers.map((m) => ({
          ...m,
          args: m.args?.join(' ') || '',
        })),
      )
      setHooks([...workspace.hooks])
    }
  }, [workspace])

  if (!workspace) return null

  const handleSave = async () => {
    setIsSaving(true)
    await updateWorkspace(workspaceId, {
      name,
      description,
      settings: {
        ...workspace.settings,
        model: model || undefined,
        apiKey: apiKey || undefined,
      },
      skills,
      mcpServers: mcpServers.map((m) => ({
        name: m.name,
        command: m.command,
        args: m.args ? m.args.split(' ').filter(Boolean) : undefined,
      })),
      hooks,
    })
    setIsSaving(false)
    onClose()
  }

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'settings', label: 'Settings' },
    { id: 'skills', label: 'Skills' },
    { id: 'mcp', label: 'MCP' },
    { id: 'hooks', label: 'Hooks' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16">
      <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 flex-shrink-0">
          <div>
            <h2 className="text-sm font-medium text-text-primary">Workspace Settings</h2>
            <p className="text-xs text-text-tertiary mt-0.5">{workspace.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border/50 flex-shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2.5 text-[11px] font-medium text-center transition-all ${
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
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'general' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary resize-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Folder Path</label>
                <input
                  value={workspace.folderPath}
                  disabled
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg text-text-tertiary cursor-not-allowed"
                />
              </div>

              <ThemeSettings />
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Model</label>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. claude-sonnet-4-5-20250929"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <p className="text-[10px] text-text-tertiary mt-1">Leave empty to use the default model.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">API Key</label>
                <div className="flex gap-2">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-ant-..."
                    className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-text-tertiary mt-1">Stored locally. Falls back to environment variable if empty.</p>
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  value={newSkill}
                  onChange={(e) => setNewSkill(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSkill.trim()) {
                      setSkills([...skills, { name: newSkill.trim() }])
                      setNewSkill('')
                    }
                  }}
                  placeholder="Skill name"
                  className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <button
                  onClick={() => {
                    if (newSkill.trim()) {
                      setSkills([...skills, { name: newSkill.trim() }])
                      setNewSkill('')
                    }
                  }}
                  className="p-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-1">
                {skills.map((skill, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-3 py-2 bg-bg rounded-lg border border-border/50"
                  >
                    <span className="text-sm text-text-primary">{skill.name}</span>
                    <button
                      onClick={() => setSkills(skills.filter((_, idx) => idx !== i))}
                      className="p-1 rounded hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {skills.length === 0 && (
                  <p className="text-xs text-text-tertiary text-center py-4">No skills added</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'mcp' && (
            <div className="space-y-3">
              <div className="space-y-2">
                <input
                  value={newMcpName}
                  onChange={(e) => setNewMcpName(e.target.value)}
                  placeholder="Server name"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <input
                  value={newMcpCommand}
                  onChange={(e) => setNewMcpCommand(e.target.value)}
                  placeholder="Command (e.g. node)"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <input
                  value={newMcpArgs}
                  onChange={(e) => setNewMcpArgs(e.target.value)}
                  placeholder="Arguments (space-separated)"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <button
                  onClick={() => {
                    if (newMcpName.trim() && newMcpCommand.trim()) {
                      setMcpServers([
                        ...mcpServers,
                        {
                          name: newMcpName.trim(),
                          command: newMcpCommand.trim(),
                          args: newMcpArgs,
                        },
                      ])
                      setNewMcpName('')
                      setNewMcpCommand('')
                      setNewMcpArgs('')
                    }
                  }}
                  className="w-full py-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add MCP Server
                </button>
              </div>
              <div className="space-y-2">
                {mcpServers.map((mcp, i) => (
                  <div
                    key={i}
                    className="px-3 py-2.5 bg-bg rounded-lg border border-border/50 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-text-primary">{mcp.name}</span>
                      <button
                        onClick={() => setMcpServers(mcpServers.filter((_, idx) => idx !== i))}
                        className="p-1 rounded hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-[11px] text-text-tertiary font-mono">
                      {mcp.command} {mcp.args}
                    </div>
                  </div>
                ))}
                {mcpServers.length === 0 && (
                  <p className="text-xs text-text-tertiary text-center py-4">No MCP servers added</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'hooks' && (
            <div className="space-y-3">
              <div className="space-y-2">
                <input
                  value={newHookName}
                  onChange={(e) => setNewHookName(e.target.value)}
                  placeholder="Hook name"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <input
                  value={newHookPath}
                  onChange={(e) => setNewHookPath(e.target.value)}
                  placeholder="Script path"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <button
                  onClick={() => {
                    if (newHookName.trim() && newHookPath.trim()) {
                      setHooks([
                        ...hooks,
                        {
                          name: newHookName.trim(),
                          scriptPath: newHookPath.trim(),
                        },
                      ])
                      setNewHookName('')
                      setNewHookPath('')
                    }
                  }}
                  className="w-full py-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Hook
                </button>
              </div>
              <div className="space-y-2">
                {hooks.map((hook, i) => (
                  <div
                    key={i}
                    className="px-3 py-2.5 bg-bg rounded-lg border border-border/50 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-text-primary">{hook.name}</span>
                      <button
                        onClick={() => setHooks(hooks.filter((_, idx) => idx !== i))}
                        className="p-1 rounded hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-[11px] text-text-tertiary font-mono truncate">
                      {hook.scriptPath}
                    </div>
                  </div>
                ))}
                {hooks.length === 0 && (
                  <p className="text-xs text-text-tertiary text-center py-4">No hooks added</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ThemeSettings() {
  const { theme, isFollowingSystem, setTheme, resetToSystem } = useTheme()

  return (
    <div className="pt-2 border-t border-border/50">
      <label className="block text-xs font-medium text-text-secondary mb-2">Appearance</label>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setTheme('light')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            theme === 'light'
              ? 'bg-accent text-accent-foreground border-accent'
              : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
          }`}
        >
          <Sun className="w-3.5 h-3.5" />
          Light
        </button>
        <button
          onClick={() => setTheme('dark')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            theme === 'dark'
              ? 'bg-accent text-accent-foreground border-accent'
              : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
          }`}
        >
          <Moon className="w-3.5 h-3.5" />
          Dark
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Monitor className="w-3 h-3 text-text-tertiary" />
        <span className="text-[11px] text-text-tertiary">
          {isFollowingSystem ? 'Following system preference' : 'Manual selection'}
        </span>
        {!isFollowingSystem && (
          <button
            onClick={resetToSystem}
            className="text-[11px] text-accent hover:text-accent-hover underline underline-offset-2"
          >
            Reset to system
          </button>
        )}
      </div>
    </div>
  )
}
