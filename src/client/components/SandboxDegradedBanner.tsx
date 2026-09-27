import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useSandboxHealth } from '../hooks/use-sandbox-health';

/**
 * Workspace-level banner for the degraded sandbox posture (U3, KTD-24).
 * Dismissal hides only this banner for the current app mount; it does not
 * change the probe state or the degraded permission posture. Re-check forces
 * a fresh probe via /api/health/sandbox?refresh=1.
 */
export default function SandboxDegradedBanner() {
  const { t } = useTranslation('common');
  const { degraded, checking, probe, recheck } = useSandboxHealth();
  const [dismissed, setDismissed] = useState(false);

  if (!degraded || dismissed) return null;

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
        type="button"
        onClick={() => void recheck()}
        disabled={checking}
        className="px-2 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-md transition-colors flex-shrink-0 disabled:opacity-50 flex items-center gap-1"
      >
        <RefreshCw className={`w-3 h-3 ${checking ? 'animate-spin' : ''}`} />
        {checking ? t('sandboxDegraded.checking') : t('sandboxDegraded.recheck')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t('sandboxDegraded.dismiss')}
        title={t('sandboxDegraded.dismiss')}
        className="p-1 text-text-secondary hover:text-text-primary rounded-md transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
