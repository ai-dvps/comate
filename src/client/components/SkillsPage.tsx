import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, HelpCircle, MoreHorizontal, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import ModalPanel, { type PanelPresentation } from './ModalPanel'
import { prepareSkillManagerDraft } from '../lib/skill-manager-draft'
import { useBackendStore } from '../stores/backend-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useCommandsStore } from '../stores/commands-store'
import type { SkillInstallation } from '../../shared/skill-types'

interface SkillsPageProps {
  workspaceId: string
  isOpen: boolean
  onClose: () => void
  onInstallSkill?: (workspaceId: string, text: string, invocationName: string) => void
  presentation?: PanelPresentation
}

const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' } as const
const EXAMPLES = ['find', 'install', 'remove', 'update'] as const

export default function SkillsPage({ workspaceId, isOpen, onClose, onInstallSkill, presentation }: SkillsPageProps) {
  const { t } = useTranslation('settings')
  const backends = useBackendStore((state) => state.backends)
  const availableAgents = backends.filter((backend) => backend.availability.status === 'available').map((backend) => backend.id)
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspaceId))
  const [copiedPath, setCopiedPath] = useState('')
  const [skills, setSkills] = useState<SkillInstallation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState('all')
  const [agent, setAgent] = useState('all')
  const [opening, setOpening] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const current = generation.current
    const requestId = ++request.current
    setLoading(true)
    try {
      const response = await fetch(`/api/skills/installed?workspaceId=${encodeURIComponent(workspaceId)}`)
      if (!response.ok) throw new Error(t('skills.fetchInstalledFailed'))
      const data = await response.json()
      if (current !== generation.current || requestId !== request.current) return
      setSkills(data.skills ?? [])
      setError('')
      useCommandsStore.getState().clearCommandsForWorkspace(workspaceId)
    } catch (cause) {
      if (current === generation.current && requestId === request.current) setError(cause instanceof Error ? cause.message : t('skills.fetchInstalledFailed'))
    } finally {
      if (current === generation.current && requestId === request.current) setLoading(false)
    }
  }, [workspaceId, t])

  useEffect(() => {
    generation.current += 1
    setSkills([])
    setOpening(false)
    if (!isOpen) return
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 5000)
    return () => {
      generation.current += 1
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [isOpen, refresh])

  const manager = skills.find((skill) => skill.scope === 'builtin' && skill.name === 'skill-manager')
  const start = async (text: string) => {
    if (opening || !manager) return
    const current = generation.current
    setOpening(true)
    try {
      const sessionId = await prepareSkillManagerDraft(workspaceId, text, manager.invocationName)
      if (current !== generation.current) return
      onClose()
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('comate:focus-prompt', { detail: { sessionId } })))
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : t('skills.manager.openFailed'))
    } finally { if (current === generation.current) setOpening(false) }
  }
  const install = () => {
    if (!opening && manager) onInstallSkill?.(workspaceId, t('skills.manager.examples.install'), manager.invocationName)
  }
  const query = filter.trim().toLowerCase()
  const matchPriority = (skill: SkillInstallation) => {
    if (!query) return 0
    const name = skill.name.toLowerCase()
    if (name === query) return 0
    if (name.startsWith(query)) return 1
    if (name.includes(query)) return 2
    return skill.description.toLowerCase().includes(query) ? 3 : -1
  }
  const visible = skills
    .filter((skill) => (skill.scope === 'builtin' || scope === 'all' || skill.scope === scope)
      && (agent === 'all' || skill.backends.some((backend) => backend === agent)))
    .map((skill) => ({ skill, priority: matchPriority(skill) }))
    .filter(({ priority }) => priority >= 0)
    .sort((a, b) => a.priority - b.priority)
    .map(({ skill }) => skill)
  const action = (skill: SkillInstallation, operation: 'update' | 'remove') => {
    void start(t('skills.manager.installationPrompt', {
      operation: t(`skills.manager.${operation}`),
      installation: JSON.stringify({ name: skill.name, scope: skill.scope, installPath: skill.installPath,
        realPath: skill.realPath, aliases: skill.aliases, agents: skill.backends.map((backend) => AGENTS[backend]),
        source: skill.source || null, version: skill.version || null }, null, 2),
    }))
  }
  const copyPath = async (path: string) => {
    try { await navigator.clipboard.writeText(path); setCopiedPath(path) }
    catch { setError(t('skills.manager.copyFailed')) }
  }
  const disabled = opening || !manager
  const buttonClass = 'min-h-9 rounded-md px-3 py-1.5 text-sm hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'

  return (
    <ModalPanel open={isOpen} onClose={onClose} presentation={presentation}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h1 className="flex items-center gap-2 font-semibold text-text-primary"><BookOpen className="h-4 w-4" />{t('skills.manager.pageTitle')}</h1>
          <div className="flex items-center gap-1">
            <Popover>
              <PopoverTrigger asChild><button type="button" className={buttonClass} aria-label={t('skills.manager.help')} title={t('skills.manager.help')}><HelpCircle className="h-4 w-4" /></button></PopoverTrigger>
              <PopoverContent aria-label={t('skills.manager.help')} align="end" sideOffset={8} className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-4 shadow-lg">
                <p className="text-sm text-text-secondary">{t('skills.manager.description')}</p>
                <p className="mt-2 text-xs text-text-tertiary">{t('skills.manager.draftHint')}</p>
                <div className="mt-3 flex flex-col items-start gap-1">
                  {EXAMPLES.map((example) => <button key={example} type="button" disabled={disabled} onClick={() => example === 'install' ? install() : void start(t(`skills.manager.examples.${example}`))} className={`${buttonClass} text-left`}>{t(`skills.manager.examples.${example}`)}</button>)}
                </div>
                <p className="mt-3 text-xs text-text-tertiary">{t('skills.manager.activationHint')}</p>
              </PopoverContent>
            </Popover>
            <button type="button" disabled={disabled} onClick={install} className={`${buttonClass} inline-flex items-center gap-1.5 bg-accent text-accent-foreground hover:opacity-90`}><Plus className="h-4 w-4" />{t('skills.manager.install')}</button>
            {presentation !== 'embedded' && <button type="button" aria-label={t('skills.manager.close')} title={t('skills.manager.close')} onClick={onClose} className={buttonClass}><X className="h-4 w-4" /></button>}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-4xl space-y-4">
            {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
            {!loading && !manager && <p role="status" className="text-sm text-text-secondary">{t('skills.manager.unavailable')}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-2 py-1.5 focus-within:ring-2 focus-within:ring-accent"><Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" /><input ref={searchInput} aria-label={t('skills.manager.filter')} placeholder={t('skills.manager.filter')} value={filter} onChange={(event) => setFilter(event.target.value)} className="min-w-0 w-full bg-transparent text-sm text-text-primary outline-none" />
                {filter && <button type="button" aria-label={t('skills.manager.clearSearch')} title={t('skills.manager.clearSearch')} onClick={() => { setFilter(''); searchInput.current?.focus() }} className="shrink-0 rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X className="h-3.5 w-3.5" /></button>}
              </div>
              <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={t('skills.manager.refresh')} title={t('skills.manager.refresh')} className={buttonClass}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
              <div className="flex w-full flex-wrap gap-2">
                <select aria-label={t('skills.manager.scopeFilter')} value={scope} onChange={(event) => setScope(event.target.value)} className="min-h-9 rounded-md border border-border bg-surface px-2 text-sm">
                  <option value="all">{t('skills.manager.allScopes')}</option>
                  {(['project', 'global'] as const).map((value) => <option key={value} value={value}>{t(`skills.manager.scope.${value}`)}</option>)}
                </select>
                <select aria-label={t('skills.manager.agentFilter')} value={agent} onChange={(event) => setAgent(event.target.value)} className="min-h-9 rounded-md border border-border bg-surface px-2 text-sm">
                  <option value="all">{t('skills.manager.allAgents')}</option>
                  {Object.entries(AGENTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
            </div>
            {(['installed', 'builtin'] as const).map((group) => {
              const items = visible.filter((skill) => (skill.scope === 'builtin') === (group === 'builtin'))
              if (group === 'builtin' && items.length === 0) return null
              return <section key={group} aria-label={t(`skills.manager.${group}`)}>
                <h2 className="mb-2 text-xs font-medium text-text-secondary">{t(`skills.manager.${group}`)} · {items.length}</h2>
                {items.length > 0 && <ul className="divide-y divide-border rounded-lg border border-border">
                  {items.map((skill) => <li key={skill.id} className="p-3 sm:p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="break-words text-base font-semibold leading-6 text-text-primary">{skill.name}</h3>
                        <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-text-secondary">{skill.description}</p>
                      </div>
                      {skill.scope !== 'builtin' && <Popover>
                        <PopoverTrigger asChild><button type="button" className={buttonClass} aria-label={t('skills.manager.actions', { name: skill.name })} title={t('skills.manager.actions', { name: skill.name })}><MoreHorizontal className="h-4 w-4" /></button></PopoverTrigger>
                        <PopoverContent align="end" sideOffset={4} aria-label={t('skills.manager.actions', { name: skill.name })} className="z-50 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-2 shadow-lg">
                          {(['update', 'remove'] as const).map((operation) => <button type="button" key={operation} disabled={disabled} onClick={() => action(skill, operation)} className={`${buttonClass} block w-full text-left`}>{t(`skills.manager.${operation}`)}</button>)}
                          <p className="px-3 py-2 text-xs text-text-tertiary">{t('skills.manager.actionHint')}</p>
                        </PopoverContent>
                      </Popover>}
                    </div>
                    <div className="mt-3 flex flex-col gap-1 text-xs leading-5 text-text-tertiary sm:flex-row sm:gap-6">
                      <span className="sm:w-48 sm:shrink-0">{skill.scope === 'builtin' ? t('skills.manager.scope.builtin') : <><span className={`inline-flex rounded px-2 py-0.5 font-medium ${skill.scope === 'project' ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'bg-purple-500/10 text-purple-700 dark:text-purple-300'}`}>{t(`skills.manager.scope.${skill.scope}`)}</span>{skill.scope === 'project' && workspace?.name ? <span className="ml-2">{workspace.name}</span> : null}</>}</span>
                      {backends.length > 0 && <span>{skill.backends.some((backend) => availableAgents.includes(backend))
                        ? t('skills.manager.appliesTo', { agents: skill.backends.length === Object.keys(AGENTS).length && availableAgents.length === Object.keys(AGENTS).length ? t('skills.manager.allAgents') : skill.backends.filter((backend) => availableAgents.includes(backend)).map((backend) => AGENTS[backend]).join('、') })
                        : t('skills.manager.noAvailableAgent')}</span>}
                    </div>
                    <details className="group mt-2 text-xs text-text-tertiary"><summary className="w-fit cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{t('skills.manager.details')}</summary>
                      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-md bg-chrome p-3 leading-5">
                        {skill.scope !== 'builtin' && <><dt>{t('skills.manager.version')}</dt><dd className="text-text-secondary">{skill.version || t('skills.manager.unknownVersion')}</dd></>}
                        <dt>{t('skills.manager.compatibleAgents')}</dt><dd className="text-text-secondary">{skill.backends.map((backend) => AGENTS[backend]).join('、')}</dd>
                        <dt>{t('skills.manager.source')}</dt><dd className="break-all text-text-secondary">{skill.source || t('skills.manager.unknownSource')}</dd>
                        <dt>{t('skills.manager.location')}</dt><dd className="min-w-0"><p className="break-all text-text-secondary">{skill.installPath}</p><button type="button" onClick={() => void copyPath(skill.installPath)} className="mt-1 rounded py-1 text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{t(copiedPath === skill.installPath ? 'skills.manager.copied' : 'skills.manager.copyPath')}</button></dd>
                        <dt>{t('skills.manager.descriptionLabel')}</dt><dd className="break-words text-text-secondary">{skill.description}</dd>
                        {skill.kind === 'expert-package-orchestrator' && <><dt>{t('skills.manager.type')}</dt><dd>{t('skills.manager.expertPackage')}</dd></>}
                        {skill.aliases.length > 0 && <><dt>{t('skills.manager.sharedPaths')}</dt><dd>{skill.aliases.map((alias) => <p key={alias} className="break-all text-text-secondary">{alias}</p>)}</dd></>}
                      </dl>
                    </details>
                  </li>)}
                </ul>}
                {!loading && group === 'installed' && items.length === 0 && <div className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
                  <p role="status">{t(skills.some((skill) => skill.scope !== 'builtin') || filter || scope !== 'all' || agent !== 'all' ? 'skills.manager.noMatches' : 'skills.manager.empty')}</p>
                  <button type="button" disabled={disabled} onClick={() => filter.trim() ? void start(t('skills.manager.findPrompt', { query: filter.trim() })) : install()} className={`${buttonClass} mt-2 text-accent`}>{t(filter.trim() ? 'skills.manager.findMore' : 'skills.manager.install')}</button>
                </div>}
              </section>
            })}
          </div>
        </div>
      </div>
    </ModalPanel>
  )
}
