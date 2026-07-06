import { useEffect, useState } from 'react';

interface MigrationHealth {
  version: number | null;
  runAt: string | null;
  auditLogsCleared: number;
}

const STORAGE_KEY = 'comate:migration-notice-dismissed';

/**
 * Shows a one-time notice when the server has completed the unified-schema
 * migration and cleared historical audit logs. The notice is dismissed per
 * browser/app install via localStorage.
 */
export function useMigrationNotice(): {
  visible: boolean;
  auditLogsCleared: number;
  dismiss: () => void;
} {
  const [health, setHealth] = useState<MigrationHealth | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    async function fetchHealth() {
      try {
        const res = await fetch('/api/health/migration');
        if (!res.ok) return;
        const data = (await res.json()) as MigrationHealth;
        if (!cancelled) setHealth(data);
      } catch {
        // ignore
      }
    }
    fetchHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // ignore
    }
    setDismissed(true);
  };

  const visible =
    !dismissed &&
    health !== null &&
    health.version === 5 &&
    health.auditLogsCleared > 0;

  return {
    visible,
    auditLogsCleared: health?.auditLogsCleared ?? 0,
    dismiss,
  };
}
