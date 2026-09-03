import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, BookOpen, Loader2, RefreshCw, Search, X } from 'lucide-react'
import ModalPanel, { type PanelPresentation } from './ModalPanel'
import { prepareSkillManagerDraft } from '../lib/skill-manager-draft'
import { useCommandsStore } from '../stores/commands-store'
import type { SkillInstallation } from '../../shared/skill-types'

interface SkillsPageProps {
  workspaceId: string
  isOpen: boolean
  onClose: () => void
  presentation?: PanelPresentation
}

const EXAMPLES = ['find', 'install', 'remove', 'update'] as const

export default function SkillsPage({ workspaceId, isOpen, onClose, presentation }: SkillsPageProps) {
  const { t } = useTranslation('settings')
  const [skills, setSkills] = useState<SkillInstallation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [opening, setOpening] = useState(false)
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
  const visible = skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(filter.toLowerCase()))

  return (
    <ModalPanel open={isOpen} onClose={onClose} presentation={presentation}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h1 className="flex items-center gap-2 font-semibold text-text-primary"><BookOpen className="h-4 w-4" />{t('skills.manager.pageTitle')}</h1>
          {presentation !== 'embedded' && <button aria-label={t('skills.manager.close')} title={t('skills.manager.close')} onClick={onClose} className="rounded p-2 hover:bg-surface-hover"><X className="h-4 w-4" /></button>}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-4xl space-y-6">
            <section aria-labelledby="skill-manager-guide" className="rounded-lg border border-border bg-chrome p-4 sm:p-5">
              <h2 id="skill-manager-guide" className="font-semibold text-text-primary">{t('skills.manager.title')}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">{t('skills.manager.description')}</p>
              <button type="button" disabled={opening || !manager} onClick={() => void start(t('skills.manager.defaultPrompt'))} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-accent-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">
                {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{t('skills.manager.action')}
              </button>
              <p className="mt-2 text-xs text-text-tertiary">{t('skills.manager.draftHint')}</p>
              <div className="mt-4 flex flex-col items-start gap-1 border-t border-border pt-3">
                <p className="mb-1 text-xs text-text-tertiary">{t('skills.manager.examplesTitle')}</p>
                {EXAMPLES.map((example) => <button key={example} type="button" disabled={opening || !manager} onClick={() => void start(t(`skills.manager.examples.${example}`))} className="min-h-9 rounded px-2 py-1 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{t(`skills.manager.examples.${example}`)}</button>)}
              </div>
              {!loading && !manager && <p role="status" className="mt-3 text-sm text-text-secondary">{t('skills.manager.unavailable')}</p>}
            </section>
            {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
            <section aria-labelledby="installed-skills-title">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 id="installed-skills-title" className="text-sm font-medium text-text-primary">{t('skills.manager.inventoryTitle', { count: skills.length })}</h2>
                <div className="flex max-w-full items-center gap-2">
                  <label className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5"><Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" /><input aria-label={t('skills.manager.filter')} placeholder={t('skills.manager.filter')} value={filter} onChange={(event) => setFilter(event.target.value)} className="min-w-0 w-40 bg-transparent text-sm text-text-primary outline-none" /></label>
                  <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={t('skills.manager.refresh')} title={t('skills.manager.refresh')} className="rounded-md p-2 text-text-secondary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
                </div>
              </div>
              {!loading && !skills.some((skill) => skill.scope !== 'builtin') && <p className="mb-4 text-sm text-text-secondary">{t('skills.manager.empty')}</p>}
              <ul className="divide-y divide-border rounded-lg border border-border">
                {visible.map((skill) => <li key={skill.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="break-all text-sm font-medium text-text-primary">{skill.name}</h3><span className="rounded bg-surface-hover px-2 py-0.5 text-xs text-text-secondary">{t(`skills.manager.scope.${skill.scope}`)}</span>{skill.kind === 'expert-package-orchestrator' && <span className="text-xs text-text-tertiary">{t('skills.manager.expertPackage')}</span>}</div>
                  <p className="mt-1 text-sm text-text-secondary">{skill.description}</p>
                  <p className="mt-2 break-all text-xs text-text-tertiary">{skill.installPath}</p>
                  <p className="mt-1 text-xs text-text-tertiary">{t('skills.manager.source')}: {skill.source || t('skills.manager.unknownSource')} · {skill.backends.join(' / ')}</p>
                  {skill.aliases.length > 0 && <details className="mt-2 text-xs text-text-tertiary"><summary className="cursor-pointer">{t('skills.manager.sharedPaths')}</summary>{skill.aliases.map((alias) => <p key={alias} className="mt-1 break-all">{alias}</p>)}</details>}
                </li>)}
              </ul>
              {!loading && visible.length === 0 && filter && <p role="status" className="py-4 text-sm text-text-tertiary">{t('skills.manager.noMatches')}</p>}
              <p className="mt-3 text-xs leading-relaxed text-text-tertiary">{t('skills.manager.activationHint')}</p>
            </section>
          </div>
        </div>
      </div>
    </ModalPanel>
  )
}
