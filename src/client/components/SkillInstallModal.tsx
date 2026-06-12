import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  Globe,
  FolderOpen,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Download,
} from 'lucide-react'
import { useSkillsStore, type SkillScope } from '../stores/skills-store'

interface SkillInstallModalProps {
  /** Source identifier — owner/repo, https URL, or local path. */
  source: string
  workspaceId: string
  onClose: () => void
  onInstalled: () => void
}

type Phase = 'resolving' | 'choosing' | 'installing' | 'result'

/**
 * Modal for installing skills from a source.
 *
 * Phase machine (U7 plan):
 *   resolving → choosing → installing → result
 *
 * - On open: call resolveSource to discover skills in the source. Display a
 *   multi-select checklist of discovered skills (none pre-checked).
 * - User picks skills + scope (2 radio cards: project / global — no local).
 * - Install disabled until at least one skill AND a scope are selected.
 * - On install: transition to `installing`. On 201 → `result` success with
 *   1200ms auto-close (mirrors ScopePickerModal:44-52). On 409 → show
 *   "Already installed" inline with Reinstall/Cancel (R8). On 422 → show
 *   error + Retry/Cancel (R7).
 * - Reinstall path: re-call install with force: true.
 */
export default function SkillInstallModal({
  source,
  workspaceId,
  onClose,
  onInstalled,
}: SkillInstallModalProps) {
  const { t } = useTranslation('settings')
  const {
    discovered,
    isSaving,
    resolveSource,
    install,
    clearDiscovered,
    clearError,
    error: storeError,
  } = useSkillsStore()

  const [phase, setPhase] = useState<Phase>('resolving')
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set())
  const [selectedScope, setSelectedScope] = useState<SkillScope | null>(null)
  const [outcome, setOutcome] = useState<
    | null
    | { kind: 'success' }
    | { kind: 'already-installed'; message: string }
    | { kind: 'error'; message: string }
  >(null)

  // Reset state when source changes / modal opens
  useEffect(() => {
    setPhase('resolving')
    setSelectedSkills(new Set())
    setSelectedScope(null)
    setOutcome(null)
    clearError()
    let cancelled = false
    resolveSource(source, workspaceId).then((ok) => {
      if (cancelled) return
      if (ok) {
        setPhase('choosing')
      } else {
        setPhase('result')
        setOutcome({ kind: 'error', message: t('skills.resolveFailed') })
      }
    })
    return () => {
      cancelled = true
      clearDiscovered()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // Auto-close on success after a brief delay
  useEffect(() => {
    if (phase === 'result' && outcome?.kind === 'success') {
      const timer = setTimeout(() => {
        onInstalled()
      }, 1200)
      return () => clearTimeout(timer)
    }
  }, [phase, outcome, onInstalled])

  const toggleSkill = useCallback((name: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }, [])

  const handleInstall = useCallback(async () => {
    if (selectedSkills.size === 0 || !selectedScope) return
    setPhase('installing')
    setOutcome(null)

    const result = await install({
      source,
      skills: Array.from(selectedSkills),
      scope: selectedScope,
      workspaceId,
    })

    if (result.status === 'success') {
      setOutcome({ kind: 'success' })
      setPhase('result')
    } else if (result.status === 'already-installed') {
      setOutcome({ kind: 'already-installed', message: result.message })
      setPhase('result')
    } else {
      setOutcome({ kind: 'error', message: result.message })
      setPhase('result')
    }
  }, [selectedSkills, selectedScope, source, workspaceId, install])

  const handleReinstall = useCallback(async () => {
    if (selectedSkills.size === 0 || !selectedScope) return
    setPhase('installing')
    setOutcome(null)
    const result = await install({
      source,
      skills: Array.from(selectedSkills),
      scope: selectedScope,
      workspaceId,
      force: true,
    })
    if (result.status === 'success') {
      setOutcome({ kind: 'success' })
      setPhase('result')
    } else {
      setOutcome({ kind: 'error', message: result.message })
      setPhase('result')
    }
  }, [selectedSkills, selectedScope, source, workspaceId, install])

  const handleRetry = useCallback(() => {
    setPhase('choosing')
    setOutcome(null)
    clearError()
  }, [clearError])

  const handleCancel = useCallback(() => {
    onClose()
  }, [onClose])

  const scopes: Array<{
    id: SkillScope
    icon: typeof Globe
    title: string
    description: string
  }> = [
    {
      id: 'project',
      icon: FolderOpen,
      title: t('skills.scopeProject'),
      description: t('skills.scopeProjectDescription', 'Shared with collaborators in this repository'),
    },
    {
      id: 'global',
      icon: Globe,
      title: t('skills.scopeGlobal'),
      description: t('skills.scopeGlobalDescription', 'Available in all your workspaces'),
    },
  ]

  const canInstall = selectedSkills.size > 0 && selectedScope !== null

  // Esc key closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'installing') {
        handleCancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [phase, handleCancel])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={phase === 'installing' ? undefined : handleCancel} />
      <div className="relative w-full max-w-lg bg-surface border border-border rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-12 border-b border-border/50 flex-shrink-0">
          <h3 className="text-sm font-medium text-text-primary truncate">
            {phase === 'resolving'
              ? t('skills.resolving')
              : phase === 'installing'
                ? t('skills.installing')
                : outcome?.kind === 'success'
                  ? t('skills.installSuccess')
                  : outcome?.kind === 'already-installed'
                    ? t('skills.alreadyInstalledTitle')
                    : outcome?.kind === 'error'
                      ? t('skills.installFailedTitle')
                      : t('skills.installTitle')}
          </h3>
          {phase !== 'installing' && (
            <button
              onClick={handleCancel}
              className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
              aria-label={t('common.cancel', 'Close')}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Source line */}
          <div className="text-[11px] text-text-tertiary">
            <span className="text-text-secondary">{t('skills.sourceLabel')}:</span>{' '}
            <span className="font-mono">{source}</span>
          </div>

          {/* Resolving phase */}
          {phase === 'resolving' && (
            <div className="flex flex-col items-center justify-center py-8 space-y-3">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
              <p className="text-sm text-text-secondary">{t('skills.resolving')}</p>
            </div>
          )}

          {/* Choosing phase */}
          {phase === 'choosing' && (
            <>
              {discovered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 space-y-2 text-center">
                  <AlertCircle className="w-6 h-6 text-text-tertiary" />
                  <p className="text-xs text-text-secondary">{t('skills.noSkillsFound')}</p>
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-2">
                      {t('skills.selectSkills', { count: discovered.length })}
                    </p>
                    <div className="space-y-1.5 max-h-[40vh] overflow-y-auto">
                      {discovered.map((skill) => {
                        const isSelected = selectedSkills.has(skill.name)
                        return (
                          <button
                            key={skill.name}
                            onClick={() => toggleSkill(skill.name)}
                            className={`w-full flex items-start gap-3 p-2.5 rounded-lg border text-left transition-colors ${
                              isSelected
                                ? 'border-accent bg-accent/5'
                                : 'border-border bg-bg hover:border-accent/30'
                            }`}
                          >
                            <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                              isSelected ? 'border-accent bg-accent' : 'border-text-tertiary'
                            }`}>
                              {isSelected && <CheckCircle2 className="w-3 h-3 text-accent-foreground" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className={`text-xs font-medium ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
                                {skill.name}
                              </span>
                              {skill.description && (
                                <p className="text-[11px] text-text-tertiary mt-0.5 line-clamp-2">
                                  {skill.description}
                                </p>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-2">
                      {t('skills.selectScope')}
                    </p>
                    <div className="space-y-2">
                      {scopes.map((scope) => {
                        const Icon = scope.icon
                        const isSelected = selectedScope === scope.id
                        return (
                          <button
                            key={scope.id}
                            onClick={() => setSelectedScope(scope.id)}
                            className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
                              isSelected
                                ? 'border-accent bg-accent/5'
                                : 'border-border bg-bg hover:border-accent/30'
                            }`}
                          >
                            <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                              isSelected ? 'border-accent' : 'border-text-tertiary'
                            }`}>
                              {isSelected && <div className="w-2 h-2 rounded-full bg-accent" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-accent' : 'text-text-tertiary'}`} />
                                <span className={`text-xs font-medium ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
                                  {scope.title}
                                </span>
                              </div>
                              <p className="text-[11px] text-text-tertiary mt-0.5">{scope.description}</p>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {storeError && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-destructive/10 rounded-lg">
                      <AlertCircle className="w-3.5 h-3.5 text-destructive" />
                      <span className="text-[11px] text-destructive flex-1">{storeError}</span>
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleCancel}
                      className="flex-1 px-4 py-2 text-xs font-medium text-text-secondary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                    <button
                      onClick={handleInstall}
                      disabled={!canInstall || isSaving}
                      className="flex-1 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {t('skills.install', 'Install')}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {/* Installing phase */}
          {phase === 'installing' && (
            <div className="flex flex-col items-center justify-center py-8 space-y-3">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
              <p className="text-sm text-text-secondary">{t('skills.installing')}</p>
              <p className="text-[11px] text-text-tertiary">
                {selectedSkills.size} skill{selectedSkills.size === 1 ? '' : 's'} ·{' '}
                {selectedScope && t(`skills.scope${selectedScope.charAt(0).toUpperCase() + selectedScope.slice(1)}`)}
              </p>
            </div>
          )}

          {/* Result - success */}
          {phase === 'result' && outcome?.kind === 'success' && (
            <div className="flex flex-col items-center justify-center py-8 space-y-3">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <p className="text-sm text-text-secondary">{t('skills.installSuccess')}</p>
            </div>
          )}

          {/* Result - already installed */}
          {phase === 'result' && outcome?.kind === 'already-installed' && (
            <div className="flex flex-col items-center justify-center py-6 space-y-3">
              <AlertCircle className="w-8 h-8 text-amber-500" />
              <p className="text-sm text-text-secondary text-center">{outcome.message}</p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 text-xs font-medium text-text-secondary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleReinstall}
                  disabled={isSaving}
                  className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('skills.reinstall')}
                </button>
              </div>
            </div>
          )}

          {/* Result - error */}
          {phase === 'result' && outcome?.kind === 'error' && (
            <div className="flex flex-col items-center justify-center py-6 space-y-3">
              <AlertCircle className="w-8 h-8 text-destructive" />
              <p className="text-sm text-text-secondary text-center max-w-sm">{outcome.message}</p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 text-xs font-medium text-text-secondary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleRetry}
                  className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('skills.retry')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
