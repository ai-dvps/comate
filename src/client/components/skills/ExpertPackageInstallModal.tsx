import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes, CheckCircle2, CircleAlert, FolderOpen, Globe, Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import {
  useExpertPackagesStore,
  type ExpertPackageDetail,
} from '../../stores/expert-packages-store'

interface ExpertPackageInstallModalProps {
  detail: ExpertPackageDetail
  workspaceId?: string
  onClose: () => void
  onCompleted: () => void
}

export default function ExpertPackageInstallModal({
  detail, workspaceId, onClose, onCompleted,
}: ExpertPackageInstallModalProps) {
  const { t } = useTranslation('settings')
  const [scope, setScope] = useState<'project' | 'global' | null>(workspaceId ? 'project' : 'global')
  const { isInstalling, installResults, installError, installPackage, clearInstall } = useExpertPackagesStore(
    useShallow((state) => ({
      isInstalling: state.isInstalling,
      installResults: state.installResults,
      installError: state.installError,
      installPackage: state.installPackage,
      clearInstall: state.clearInstall,
    })),
  )

  useEffect(() => {
    clearInstall()
    return clearInstall
  }, [clearInstall])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isInstalling) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isInstalling, onClose])

  const failedIds = useMemo(
    () => installResults.filter((result) => result.status === 'error').map((result) => result.id),
    [installResults],
  )

  const runInstall = async (itemIds?: string[]) => {
    if (!scope || isInstalling) return
    await installPackage({ packageSlug: detail.slug, scope, workspaceId, itemIds })
    onCompleted()
  }

  const hasResults = installResults.length > 0

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" data-modal-overlay="" aria-label={t('skills.expertPackages.installDialog')}>
      <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={isInstalling ? undefined : onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('skills.expertPackages.installTitle', { name: detail.displayName })}</h3>
            <p className="mt-0.5 text-[10px] text-text-tertiary">{t('skills.expertPackages.inAppOnly')}</p>
          </div>
          <button onClick={onClose} disabled={isInstalling} className="rounded-lg p-2 text-text-tertiary hover:bg-surface-hover disabled:opacity-50" aria-label={t('common.cancel')} title={t('common.cancel')}><X className="h-4 w-4" /></button>
        </header>

        <div className="space-y-4 overflow-y-auto p-5">
          {!hasResults && (
            <>
              <section>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t('skills.expertPackages.installLocation')}</h4>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setScope('project')}
                    disabled={!workspaceId}
                    className={`rounded-xl border p-3 text-left ${scope === 'project' ? 'border-accent bg-accent/5' : 'border-border bg-bg'} disabled:opacity-40`}
                  >
                    <FolderOpen className={`h-4 w-4 ${scope === 'project' ? 'text-accent' : 'text-text-tertiary'}`} />
                    <span className="mt-2 block text-xs font-medium text-text-primary">{t('skills.expertPackages.project')}</span>
                    <span className="mt-0.5 block text-[10px] text-text-tertiary">{t('skills.expertPackages.projectDescription')}</span>
                  </button>
                  <button
                    onClick={() => setScope('global')}
                    className={`rounded-xl border p-3 text-left ${scope === 'global' ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}
                  >
                    <Globe className={`h-4 w-4 ${scope === 'global' ? 'text-accent' : 'text-text-tertiary'}`} />
                    <span className="mt-2 block text-xs font-medium text-text-primary">{t('skills.expertPackages.global')}</span>
                    <span className="mt-0.5 block text-[10px] text-text-tertiary">{t('skills.expertPackages.globalDescription')}</span>
                  </button>
                </div>
              </section>

              <section>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t('skills.expertPackages.contents')}</h4>
                <div className="mt-2 overflow-hidden rounded-xl border border-border">
                  <div className="flex items-center gap-3 bg-accent/5 p-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><Sparkles className="h-3.5 w-3.5" /></div>
                    <div className="min-w-0 flex-1"><p className="text-xs font-medium text-text-primary">{t('skills.expertPackages.orchestrationName', { name: detail.displayName })}</p><p className="mt-0.5 text-[10px] text-text-tertiary">{t('skills.expertPackages.orchestrationHint')}</p></div>
                    <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-medium text-accent">{t('skills.expertPackages.orchestrationBadge')}</span>
                  </div>
                  {detail.children.map((child) => (
                    <div key={`${child.namespace}/${child.slug}`} className="flex items-center gap-3 border-t border-border p-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-hover text-text-secondary"><Boxes className="h-3.5 w-3.5" /></div>
                      <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-text-primary">{child.displayName}</p><p className="mt-0.5 truncate text-[10px] text-text-tertiary">{child.namespace}/{child.slug}</p></div>
                      <span className="text-[10px] text-text-tertiary">Skill</span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}

          {(hasResults || installError) && (
            <section>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t('skills.expertPackages.installResult')}</h4>
              {installError && <div className="mt-2 flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive"><CircleAlert className="h-4 w-4 shrink-0" />{installError}</div>}
              <div className="mt-2 space-y-1.5">
                {installResults.map((result) => (
                  <div key={result.id} className="flex items-center gap-3 rounded-xl border border-border bg-bg p-3">
                    {result.status === 'error'
                      ? <CircleAlert className="h-4 w-4 shrink-0 text-destructive" />
                      : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />}
                    <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-text-primary">{result.name}</p>{result.error && <p className="mt-0.5 text-[10px] text-destructive">{result.error}</p>}</div>
                    <span className={`text-[10px] ${result.status === 'error' ? 'text-destructive' : 'text-text-tertiary'}`}>
                      {t(result.status === 'installed' ? 'skills.expertPackages.installed' : result.status === 'already-installed' ? 'skills.expertPackages.skipped' : 'skills.expertPackages.failed')}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} disabled={isInstalling} className="rounded-lg px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50">{t(hasResults ? 'skills.expertPackages.done' : 'skills.expertPackages.cancel')}</button>
          {failedIds.length > 0 ? (
            <button onClick={() => void runInstall(failedIds)} disabled={isInstalling || !scope} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-foreground disabled:opacity-50">
              {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {t('skills.expertPackages.retryFailed')}
            </button>
          ) : !hasResults ? (
            <button onClick={() => void runInstall()} disabled={isInstalling || !scope} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-foreground disabled:opacity-50">
              {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Boxes className="h-3.5 w-3.5" />} {t('skills.expertPackages.confirmInstall')}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  )
}
