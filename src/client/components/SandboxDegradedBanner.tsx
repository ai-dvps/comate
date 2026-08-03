import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useSandboxHealth } from '../hooks/use-sandbox-health';

/**
 * Persistent workspace-level banner for the degraded sandbox posture (U3,
 * KTD-24). Renders whenever the host's spawn probe fails; there is NO manual
 * dismissal — the banner clears only when a probe passes (the re-check button
 * forces a fresh probe via /api/health/sandbox?refresh=1).
 */
export default function SandboxDegradedBanner() {
  const { t } = useTranslation('common');
  const { degraded, checking, probe, recheck } = useSandboxHealth();

  if (!degraded) return null;

  const reason = probe?.failures.join(', ') ?? '';

  return (
    <div
      data-testid="sandbox-degraded-banner"
      className="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-surface border border-warning rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 max-w-xl"
      role="alert"
    >
      <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
      <div className="flex flex-col text-xs min-w-0">
        <span className="font-medium text-text-primary">{t('sandboxDegraded.title')}</span>
        <span className="text-text-secondary">
          {t('sandboxDegraded.message', { reason })}
        </span>
      </div>
      <button
        onClick={() => void recheck()}
        disabled={checking}
        className="px-2 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-md transition-colors flex-shrink-0 disabled:opacity-50 flex items-center gap-1"
      >
        <RefreshCw className={`w-3 h-3 ${checking ? 'animate-spin' : ''}`} />
        {checking ? t('sandboxDegraded.checking') : t('sandboxDegraded.recheck')}
      </button>
    </div>
  );
}
